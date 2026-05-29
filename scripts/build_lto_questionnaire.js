const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SITE = "https://portal.lto.gov.ph";
const ORDS = `${SITE}/ords/`;
const START_URL = `${ORDS}f?p=ELEARNING:HOME:0:::1::`;
const OUT_DIR = path.join(process.cwd(), "data", "portal.lto.gov.ph");
const IMG_DIR = path.join(OUT_DIR, "images");
const JSON_PATH = path.join(OUT_DIR, "portal.lto.gov.ph.json");
const REPORT_PATH = path.join(OUT_DIR, "source_report.md");

const RATE_LIMIT_MS = 225;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const INCLUDED_ROOTS = new Set([
  "LICENSING INFORMATION",
  "GETTING READY TO DRIVE",
  "ROAD TRAFFIC SIGNS",
  "DRIVING FUNDAMENTALS",
  "ROAD COURTESY AND SAFETY",
  "RIGHTS, DUTIES AND RESPONSIBILITIES OF DRIVERS",
  "MOTOR VEHICLE REGISTRATION",
  "LAND TRANSPORTATION RELATED LAWS",
  "FINES AND PENALTIES FOR VIOLATIONS"
]);

const EXCLUDED_PATH_PATTERNS = [
  /DRIVER'?S LICENSE RENEWAL COURSE/i,
  /PROFESSIONAL CDE COURSE/i,
  /HEAVY VEHICLE \(C, CE, D\)/i,
  /CONDUCTOR'?S LICENSE \(CL\)/i,
  /VIOLATIONS IN CONNECTION WITH FRANCHISE/i
];

const EXCLUDED_TEXT_PATTERNS = [
  /\bPROFESSIONAL DL\b/i,
  /\bPDL\b/i,
  /\bCONDUCTOR'?S\b/i,
  /\bCONDUCTOR\b/i,
  /\bpublic utility vehicle\b/i,
  /\bpassenger bus\b/i,
  /\bfor hire\b/i,
  /\bfranchise\b/i
];

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul"
]);

const state = {
  visited: [],
  followed: [],
  skipped: [],
  downloadedImages: new Map(),
  imageHashes: new Map(),
  usedImageNames: new Set(),
  imageRecords: []
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithLimit(url) {
  await delay(RATE_LIMIT_MS);
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response;
}

async function fetchText(url) {
  const response = await fetchWithLimit(url);
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetchWithLimit(url);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || ""
  };
}

function decodeEntities(value) {
  if (!value) return "";
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    ndash: "-",
    mdash: "-",
    lsquo: "'",
    rsquo: "'",
    ldquo: "\"",
    rdquo: "\"",
    bull: "-",
    deg: " degrees "
  };
  return String(value)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) {
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith("#")) {
        return String.fromCodePoint(parseInt(lower.slice(1), 10));
      }
      return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
    })
    .replace(/\u00a0/g, " ");
}

function cleanText(value) {
  return decodeEntities(value)
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function cleanInline(value) {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

function parseAttrs(raw) {
  const attrs = {};
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRe.exec(raw))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function parseHtml(html) {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const root = { type: "element", tag: "#document", attrs: {}, children: [], parent: null };
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let lastIndex = 0;
  let match;
  while ((match = tagRe.exec(withoutScripts))) {
    const text = withoutScripts.slice(lastIndex, match.index);
    if (text) {
      stack[stack.length - 1].children.push({
        type: "text",
        text,
        parent: stack[stack.length - 1]
      });
    }
    lastIndex = tagRe.lastIndex;
    const token = match[0];
    const tag = match[1] ? match[1].toLowerCase() : "";
    if (!tag || token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const popped = stack.pop();
        if (popped.tag === tag) break;
      }
      continue;
    }
    const rawAttrs = match[2] || "";
    const node = {
      type: "element",
      tag,
      attrs: parseAttrs(rawAttrs),
      children: [],
      parent: stack[stack.length - 1]
    };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) {
      stack.push(node);
    }
  }
  const tail = withoutScripts.slice(lastIndex);
  if (tail) {
    stack[stack.length - 1].children.push({
      type: "text",
      text: tail,
      parent: stack[stack.length - 1]
    });
  }
  return root;
}

function elementChildren(node, tagName = null) {
  return (node.children || []).filter(
    (child) => child.type === "element" && (!tagName || child.tag === tagName)
  );
}

function walk(node, predicate, found = []) {
  if (node.type === "element" && predicate(node)) found.push(node);
  for (const child of node.children || []) {
    walk(child, predicate, found);
  }
  return found;
}

function findFirst(node, predicate) {
  if (node.type === "element" && predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function hasClass(node, className) {
  const classes = (node.attrs.class || "").split(/\s+/).filter(Boolean);
  return classes.includes(className);
}

function textContent(node) {
  if (!node) return "";
  if (node.type === "text") return decodeEntities(node.text);
  if (node.tag === "br") return "\n";
  const parts = [];
  for (const child of node.children || []) {
    parts.push(textContent(child));
  }
  const joined = parts.join("");
  return BLOCK_TAGS.has(node.tag) ? `\n${joined}\n` : joined;
}

function nodeText(node) {
  return cleanInline(textContent(node));
}

function directTextFromFirstAnchor(li) {
  const anchor = elementChildren(li, "a")[0];
  return anchor ? nodeText(anchor) : "";
}

function parseTree(dom) {
  const tree = findFirst(dom, (node) => node.tag === "div" && node.attrs.id === "t_TreeNav");
  if (!tree) return [];
  const rootUl = elementChildren(tree, "ul")[0];
  if (!rootUl) return [];
  return elementChildren(rootUl, "li").map((li) => parseTreeLi(li, []));
}

function parseTreeLi(li, parentPath) {
  const directA = elementChildren(li, "a")[0] || null;
  const title = cleanInline(li.attrs["data-disabled"] || directTextFromFirstAnchor(li));
  const node = {
    title,
    type: cleanInline(li.attrs["data-id"] || ""),
    href: directA ? directA.attrs.href || "" : "",
    path: [...parentPath, title],
    children: []
  };
  const childUl = elementChildren(li, "ul")[0];
  if (childUl) {
    node.children = elementChildren(childUl, "li").map((childLi) =>
      parseTreeLi(childLi, node.path)
    );
  }
  return node;
}

function flattenTree(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    flattenTree(node.children, out);
  }
  return out;
}

function pathString(node) {
  return node.path.filter(Boolean).join(" / ");
}

function shouldSkipNode(node) {
  const fullPath = pathString(node);
  if (!INCLUDED_ROOTS.has((node.path[0] || "").toUpperCase())) {
    return "outside selected Driver's Manual roots";
  }
  const pattern = EXCLUDED_PATH_PATTERNS.find((candidate) => candidate.test(fullPath));
  if (pattern) return `excluded by scope filter (${pattern})`;
  return "";
}

function absoluteUrl(href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("f?p=")) return `${ORDS}${href}`;
  if (href.startsWith("/")) return `${SITE}${href}`;
  return new URL(href, ORDS).toString();
}

function canonicalElearningUrl(href) {
  const abs = absoluteUrl(href);
  return abs.replace(/(\/ords\/f\?p=ELEARNING:[^:]*:)[^:]*/i, (_match, prefix) => `${prefix}0`);
}

function pageNumberFromUrl(url) {
  const match = /f\?p=ELEARNING:([^:]+):/i.exec(url);
  return match ? match[1].toUpperCase() : "";
}

function topicIdFromUrl(url) {
  const match = /P\d+_TOPICS_FK:([^:&]+)/i.exec(url);
  return match ? match[1] : "";
}

function slugify(value, fallback = "item") {
  const slug = cleanInline(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function categoryForPath(pathParts) {
  const joined = pathParts.join(" / ").toLowerCase();
  if (joined.includes("road traffic signs") || joined.includes("signs")) return "road_traffic_signs";
  if (joined.includes("pavement marking")) return "pavement_markings";
  if (joined.includes("traffic light") || joined.includes("traffic signal")) return "traffic_lights";
  if (joined.includes("defensive driving")) return "defensive_driving";
  if (joined.includes("laws")) return "land_transportation_related_laws";
  if (joined.includes("fines") || joined.includes("penalties")) return "fines_and_penalties";
  if (joined.includes("licensing")) return "licensing_information";
  if (joined.includes("getting ready")) return "getting_ready_to_drive";
  if (joined.includes("driving fundamentals")) return "driving_fundamentals";
  if (joined.includes("road courtesy")) return "road_courtesy_and_safety";
  if (joined.includes("rights, duties")) return "rights_duties_and_responsibilities";
  if (joined.includes("motor vehicle registration")) return "motor_vehicle_registration";
  return slugify(pathParts[0] || "driver_manual").replace(/-/g, "_");
}

function firstStrongText(node) {
  const strong = findFirst(node, (candidate) => candidate.tag === "strong");
  return strong ? nodeText(strong) : "";
}

function allStrongTexts(node) {
  return walk(node, (candidate) => candidate.tag === "strong")
    .map((candidate) => nodeText(candidate))
    .filter(Boolean);
}

function titleFromFilename(src) {
  if (!src) return "";
  try {
    const parsed = new URL(absoluteUrl(src));
    const filenameParam = parsed.searchParams.get("FILENAME") || parsed.searchParams.get("filename");
    const rawName = filenameParam || path.posix.basename(parsed.pathname);
    const stem = cleanInline(path.basename(rawName, path.extname(rawName)).replace(/-20/g, " "));
    return stem
      .replace(/[_-]+/g, " ")
      .replace(/\b(lto|ltfrb|puj|pwd|ah|dl|npdl|sp|ra|r\.a)\b/gi, (match) => match.toUpperCase())
      .replace(/\b[a-z]/g, (match) => match.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();
  } catch (_error) {
    return "";
  }
}

function isUppercaseLike(value) {
  const letters = value.replace(/[^a-z]/gi, "");
  if (!letters) return false;
  const uppercase = letters.replace(/[^A-Z]/g, "");
  return uppercase.length / letters.length > 0.55;
}

function trimLabelCandidate(value) {
  return cleanInline(value)
    .replace(/\s+(?:is|are|means|refers to|consists?|indicates?)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveImageLabel(textNode, page, src) {
  const description = nodeText(textNode);
  const strongs = allStrongTexts(textNode);
  let label = "";
  if (strongs.length) {
    const joined = [];
    for (const strong of strongs) {
      const candidate = cleanInline([...joined, strong].join(" "));
      if (description.toLowerCase().startsWith(candidate.toLowerCase())) {
        joined.push(strong);
      }
    }
    label = cleanInline(joined.length ? joined.join(" ") : strongs[0]);
  }
  if (!label) {
    const candidate = trimLabelCandidate(description.split(/\s+-\s+|\s+--\s+|:/)[0] || "");
    if (candidate.length >= 3 && candidate.length <= 100 && isUppercaseLike(candidate)) {
      label = candidate;
    }
  }
  if (!label || label.length > 100) {
    label = titleFromFilename(src);
  }
  if (!label || label.length > 100) {
    label = page.title;
  }
  return cleanInline(label);
}

function extractBreadcrumb(dom) {
  const crumb = findFirst(dom, (node) => hasClass(node, "elearn-breadcrumb"));
  if (!crumb) return [];
  return walk(crumb, (node) => hasClass(node, "topic-header"))
    .map((node) => nodeText(node))
    .filter(Boolean);
}

function extractTitle(dom, fallback) {
  const regionTitle = findFirst(dom, (node) => node.tag === "h2" && hasClass(node, "t-Region-title"));
  return regionTitle ? nodeText(regionTitle) : fallback;
}

function extractImageDescriptionItems(dom, page) {
  const blocks = walk(dom, (node) => hasClass(node, "images-description"));
  return blocks
    .map((block) => {
      const img = findFirst(block, (node) => node.tag === "img" && node.attrs.src);
      const textNode = findFirst(block, (node) => hasClass(node, "text")) || block;
      const description = nodeText(textNode);
      const label = deriveImageLabel(textNode, page, img ? img.attrs.src : "");
      return {
        label,
        description,
        src: img ? img.attrs.src : "",
        pageTitle: page.title,
        sourceUrl: page.url,
        path: page.path,
        category: page.category
      };
    })
    .filter((item) => item.label || item.src || item.description);
}

function extractImageTextItems(dom, page) {
  const blocks = walk(dom, (node) => hasClass(node, "image-text"));
  const items = [];
  for (const block of blocks) {
    const images = walk(block, (node) => node.tag === "img" && node.attrs.src);
    const textNode = findFirst(block, (node) => hasClass(node, "text")) || block;
    const description = nodeText(textNode);
    for (const img of images) {
      const label = deriveImageLabel(textNode, page, img.attrs.src) || page.title;
      items.push({
        label,
        description,
        src: img.attrs.src,
        pageTitle: page.title,
        sourceUrl: page.url,
        path: page.path,
        category: page.category
      });
    }
  }
  return items;
}

function findTextContentNode(dom) {
  const textRows = walk(dom, (node) => hasClass(node, "text") && hasClass(node, "row"));
  if (textRows.length) return textRows[0];
  return findFirst(dom, (node) => hasClass(node, "t-Region-body"));
}

function extractTextRecords(dom, page) {
  const content = findTextContentNode(dom);
  if (!content) return [];
  const elements = walk(content, (node) =>
    /^(h[1-6]|p|li|tr)$/.test(node.tag)
  );
  const records = [];
  let heading = page.title;
  let listIndex = 0;
  for (const element of elements) {
    const text = nodeText(element);
    if (!text) continue;
    if (/^h[1-6]$/.test(element.tag)) {
      heading = text;
      continue;
    }
    if (element.tag === "tr") {
      const cells = elementChildren(element)
        .filter((child) => child.tag === "td" || child.tag === "th")
        .map((child) => nodeText(child))
        .filter(Boolean);
      if (cells.length >= 2) {
        records.push({
          kind: "table",
          heading,
          text: cells.join(" | "),
          cells,
          strongs: [],
          page
        });
      }
      continue;
    }
    if (element.tag === "li") listIndex += 1;
    records.push({
      kind: element.tag === "li" ? "list" : "paragraph",
      heading,
      text,
      strongs: allStrongTexts(element),
      index: listIndex,
      page
    });
  }
  return records;
}

function isTextInScope(value) {
  if (!value) return false;
  return !EXCLUDED_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function trimAnswer(value, max = 280) {
  const clean = cleanInline(value);
  if (clean.length <= max) return clean;
  return "";
}

function splitSentences(text) {
  return cleanInline(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function extractDefinitions(records) {
  const definitions = [];
  for (const record of records) {
    if (!isTextInScope(`${record.heading} ${record.text}`)) continue;
    const strong = (record.strongs || []).find((item) => item.length >= 2 && item.length <= 85);
    if (!strong) continue;
    const term = cleanInline(strong.replace(/[-:]+$/g, ""));
    if (!term || /^(VALIDITY|NOTE|REMEMBER|WARNING)$/i.test(term)) continue;
    const pattern = new RegExp(`^${escapeRegExp(term)}\\s*(?:-|--|:|is|means|refers to|refers)\\s*`, "i");
    if (!pattern.test(record.text)) continue;
    const definition = trimAnswer(record.text.replace(pattern, ""));
    if (!definition || definition.length < 18 || definition.length > 240) continue;
    definitions.push({
      term,
      definition,
      record
    });
  }
  return definitions;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractClozeCandidates(records) {
  const candidates = [];
  for (const record of records) {
    if (!isTextInScope(`${record.heading} ${record.text}`)) continue;
    const sentences = splitSentences(record.text);
    for (const sentence of sentences) {
      if (sentence.length < 45 || sentence.length > 210) continue;
      const phrase = chooseClozePhrase(sentence);
      if (!phrase) continue;
      if (phrase.value.length < 3) continue;
      const phraseIndex = sentence.indexOf(phrase.value);
      const before = phraseIndex > 0 ? sentence[phraseIndex - 1] : "";
      const after = sentence[phraseIndex + phrase.value.length] || "";
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      const cloze = sentence.replace(phrase.value, "____");
      if (cloze === sentence) continue;
      candidates.push({
        phrase: phrase.value,
        type: phrase.type,
        cloze,
        sentence,
        record
      });
    }
  }
  return candidates;
}

function extractStatementCandidates(records) {
  const candidates = [];
  const seenContext = new Set();
  for (const record of records) {
    if (record.kind === "table") continue;
    if (!isTextInScope(`${record.heading} ${record.text}`)) continue;
    const page = record.page;
    const context = trimAnswer(page.path.slice(-2).join(" / ") || page.title, 150);
    const contextKey = `${page.url}|${record.heading}`;
    if (seenContext.has(contextKey)) continue;
    const sentence = splitSentences(record.text)
      .find((item) => item.length >= 55 && item.length <= 220);
    if (!sentence) continue;
    if (
      !/\b(must|shall|should|required|requires|prohibited|allowed|before|after|when|while|safe|safety|driver|vehicle|motorist|road|traffic|license|permit|applicant|right of way|emergency)\b/i.test(
        sentence
      )
    ) {
      continue;
    }
    seenContext.add(contextKey);
    candidates.push({
      context,
      statement: sentence,
      record
    });
  }
  return candidates;
}

function chooseClozePhrase(sentence) {
  const amount = sentence.match(/(?:P|PHP|Php|₱)\s*[\d,]+(?:\.\d{2})?/);
  if (amount) return { type: "amount", value: amount[0] };

  const duration = sentence.match(
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty|ninety|[0-9]+)\s*(?:\([0-9]+\)\s*)?(?:year|years|month|months|day|days|hour|hours)\b/i
  );
  if (duration) return { type: "duration", value: duration[0] };

  const age = sentence.match(
    /\b(?:sixteen|seventeen|eighteen|[0-9]+)\s*(?:\([0-9]+\)\s*)?years?\s*old\b/i
  );
  if (age) return { type: "age", value: age[0] };

  const distance = sentence.match(
    /\b[0-9]+(?:\.[0-9]+)?\s*(?:meters|meter|m|kilometers|kilometer|km|centimeters|centimeter|feet|foot|seconds|second)\b/i
  );
  if (distance) return { type: "distance", value: distance[0] };

  const percent = sentence.match(/\b[0-9]+(?:\.[0-9]+)?\s*%\b/);
  if (percent) return { type: "percent", value: percent[0] };

  return null;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = cleanInline(value);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function hashNumber(value) {
  const digest = crypto.createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0);
}

function deterministicChoices(answer, pool, key) {
  const answerClean = cleanInline(answer);
  const options = unique(pool).filter((item) => item.toLowerCase() !== answerClean.toLowerCase());
  options.sort((a, b) => hashNumber(`${key}|${a}`) - hashNumber(`${key}|${b}`));
  const picked = [answerClean, ...options.slice(0, 3)];
  if (picked.length < 4) return [];
  picked.sort((a, b) => hashNumber(`${key}|choice|${a}`) - hashNumber(`${key}|choice|${b}`));
  return picked;
}

function makeQuestion({ question, answer, category, image = "", pool, key }) {
  const cleanQuestion = cleanInline(question);
  const cleanAnswer = cleanInline(answer);
  if (!cleanQuestion || !cleanAnswer) return null;
  const choices = deterministicChoices(cleanAnswer, pool, key || `${cleanQuestion}|${cleanAnswer}|${image}`);
  if (choices.length !== 4 || !choices.includes(cleanAnswer)) return null;
  return {
    language: "english",
    category,
    question: cleanQuestion,
    img: image,
    answer: cleanAnswer,
    "choices/c1": choices[0],
    "choices/c2": choices[1],
    "choices/c3": choices[2],
    "choices/c4": choices[3]
  };
}

function buildQuestions(pages, imageItems) {
  const questions = [];
  const visualCategories = new Set(["road_traffic_signs", "pavement_markings", "traffic_lights"]);
  const signItems = imageItems.filter(
    (item) =>
      item.localPath &&
      item.label &&
      item.label.length <= 120 &&
      visualCategories.has(item.category)
  );
  const labelsByCategory = new Map();
  for (const item of signItems) {
    const key = item.category;
    if (!labelsByCategory.has(key)) labelsByCategory.set(key, []);
    labelsByCategory.get(key).push(item.label);
  }

  for (const item of signItems) {
    const isMarking = item.path.join(" / ").toLowerCase().includes("pavement");
    const isFlowchart = /flowchart/i.test(item.label);
    const questionText = isFlowchart
      ? "What LTO Driver's Manual topic does this image show?"
      : isMarking
        ? "Identify this pavement marking."
        : "Identify this sign.";
    const pool = [
      ...(labelsByCategory.get(item.category) || []),
      ...signItems
        .filter((candidate) => candidate.category === item.category)
        .map((candidate) => candidate.label)
    ];
    const question = makeQuestion({
      question: questionText,
      answer: item.label,
      category: item.category,
      image: item.localPath,
      pool,
      key: `${item.sourceUrl}|${item.localPath}`
    });
    if (question) questions.push(question);
  }

  const allDefinitions = [];
  const allClozes = [];
  const allStatements = [];
  const allRows = [];
  for (const page of pages) {
    const records = page.textRecords || [];
    allDefinitions.push(...extractDefinitions(records));
    allClozes.push(...extractClozeCandidates(records));
    allStatements.push(...extractStatementCandidates(records));
    for (const record of records) {
      if (record.kind === "table" && record.cells.length >= 2 && isTextInScope(record.text)) {
        const answer = trimAnswer(record.cells.slice(1).join(" / "), 220);
        const label = trimAnswer(record.cells[0], 90);
        if (answer && label && !/^requirements?$/i.test(label)) {
          allRows.push({ label, answer, record });
        }
      }
    }
  }

  const definitionPool = allDefinitions.map((item) => item.definition);
  for (const item of allDefinitions) {
    const question = makeQuestion({
      question: `What does "${item.term}" mean in the LTO Driver's Manual?`,
      answer: item.definition,
      category: item.record.page.category,
      pool: definitionPool,
      key: `def|${item.record.page.url}|${item.term}`
    });
    if (question) questions.push(question);
  }

  const clozePools = new Map();
  for (const item of allClozes) {
    if (!clozePools.has(item.type)) clozePools.set(item.type, []);
    clozePools.get(item.type).push(item.phrase);
  }
  for (const item of allClozes) {
    const pool = clozePools.get(item.type) || [];
    const question = makeQuestion({
      question: `According to the "${item.record.page.title}" section, complete the statement: "${item.cloze}"`,
      answer: item.phrase,
      category: item.record.page.category,
      pool,
      key: `cloze|${item.record.page.url}|${item.sentence}`
    });
    if (question) questions.push(question);
  }

  const statementPool = allStatements.map((item) => item.statement);
  for (const item of allStatements) {
    const pool = statementPool.filter(
      (statement) => statement.toLowerCase() !== item.statement.toLowerCase()
    );
    const question = makeQuestion({
      question: `Which statement is included in "${item.context}"?`,
      answer: item.statement,
      category: item.record.page.category,
      pool,
      key: `statement|${item.record.page.url}|${item.record.heading}|${item.statement}`
    });
    if (question) questions.push(question);
  }

  const amountRows = allRows
    .map((row) => {
      const match = row.answer.match(/(?:P|PHP|Php|₱)\s*[\d,]+(?:\.\d{2})?/);
      const label = trimAnswer(row.label, 140);
      if (!match || !label || /^\d+$/.test(label) || /^particulars?$/i.test(label)) return null;
      if (!isTextInScope(`${row.record.page.title} ${label} ${row.answer}`)) return null;
      return { ...row, amount: match[0], label };
    })
    .filter(Boolean);
  const amountPool = amountRows.map((row) => row.amount);
  for (const row of amountRows) {
    const question = makeQuestion({
      question: `What fine or fee is listed for "${row.label}" in the "${row.record.page.title}" section?`,
      answer: row.amount,
      category: row.record.page.category,
      pool: amountPool,
      key: `amount-row|${row.record.page.url}|${row.label}`
    });
    if (question) questions.push(question);
  }

  return dedupeQuestions(questions);
}

function dedupeQuestions(questions) {
  const seenExact = new Set();
  const out = [];
  for (const question of questions) {
    const key = [
      question.question.toLowerCase(),
      question.answer.toLowerCase(),
      question.img.toLowerCase()
    ].join("|");
    if (seenExact.has(key)) continue;
    seenExact.add(key);
    out.push(question);
  }
  return out;
}

function filenameFromImageUrl(url, label) {
  const parsed = new URL(url);
  const filenameParam = parsed.searchParams.get("FILENAME") || parsed.searchParams.get("filename");
  const rawName = filenameParam || path.posix.basename(parsed.pathname) || `${slugify(label)}.png`;
  const ext = path.extname(rawName).toLowerCase() || ".png";
  const base = slugify(path.basename(rawName, path.extname(rawName)) || label, "image");
  return `${base}${ext}`;
}

function extensionFromContentType(contentType) {
  if (/png/i.test(contentType)) return ".png";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  if (/gif/i.test(contentType)) return ".gif";
  if (/webp/i.test(contentType)) return ".webp";
  if (/svg/i.test(contentType)) return ".svg";
  return "";
}

function uniqueImageFilename(baseName, buffer, contentType) {
  let ext = path.extname(baseName).toLowerCase();
  const typeExt = extensionFromContentType(contentType);
  if (!ext && typeExt) {
    ext = typeExt;
    baseName = `${baseName}${ext}`;
  }
  let stem = path.basename(baseName, path.extname(baseName));
  stem = slugify(stem, "image");
  ext = ext || ".png";
  let candidate = `${stem}${ext}`;
  let index = 2;
  while (state.usedImageNames.has(candidate.toLowerCase())) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  state.usedImageNames.add(candidate.toLowerCase());
  return candidate;
}

async function downloadImage(src, label) {
  const url = absoluteUrl(src);
  if (state.downloadedImages.has(url)) return state.downloadedImages.get(url);
  const { buffer, contentType } = await fetchBuffer(url);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (state.imageHashes.has(hash)) {
    const existing = state.imageHashes.get(hash);
    state.downloadedImages.set(url, existing);
    return existing;
  }
  const rawName = filenameFromImageUrl(url, label);
  const fileName = uniqueImageFilename(rawName, buffer, contentType);
  const absolutePath = path.join(IMG_DIR, fileName);
  fs.writeFileSync(absolutePath, buffer);
  const localPath = `data/portal.lto.gov.ph/images/${fileName}`;
  state.downloadedImages.set(url, localPath);
  state.imageHashes.set(hash, localPath);
  state.imageRecords.push({
    sourceUrl: url,
    localPath,
    bytes: buffer.length,
    contentType
  });
  return localPath;
}

async function collectPages(leafNodes) {
  const pages = [];
  const imageItems = [];
  for (const node of leafNodes) {
    const url = canonicalElearningUrl(node.href);
    state.followed.push({
      title: node.title,
      type: node.type,
      path: pathString(node),
      url
    });
    const html = await fetchText(url);
    const dom = parseHtml(html);
    const title = extractTitle(dom, node.title);
    const breadcrumbs = extractBreadcrumb(dom);
    const page = {
      title,
      type: node.type,
      url,
      topicId: topicIdFromUrl(url),
      pageNumber: pageNumberFromUrl(url),
      path: breadcrumbs.length ? breadcrumbs : node.path,
      category: categoryForPath(breadcrumbs.length ? breadcrumbs : node.path),
      textRecords: [],
      imageItems: []
    };
    page.textRecords = page.type === "TEXT" ? extractTextRecords(dom, page) : [];
    if (page.type === "IMAGE_TEXT_LIST") {
      page.imageItems = extractImageDescriptionItems(dom, page);
    } else if (page.type === "IMAGE_TEXT") {
      page.imageItems = extractImageTextItems(dom, page);
    }
    for (const item of page.imageItems) {
      if (item.src) {
        item.localPath = await downloadImage(item.src, item.label || page.title);
      }
      imageItems.push(item);
    }
    pages.push(page);
    state.visited.push({
      title: page.title,
      type: page.type,
      path: page.path.join(" / "),
      url: page.url,
      textRecords: page.textRecords.length,
      images: page.imageItems.length
    });
  }
  return { pages, imageItems };
}

function writeJson(questions) {
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(questions, null, 2)}\n`, "utf8");
}

function validateQuestions(questions) {
  JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const errors = [];
  const required = [
    "language",
    "category",
    "question",
    "img",
    "answer",
    "choices/c1",
    "choices/c2",
    "choices/c3",
    "choices/c4"
  ];
  for (const [index, question] of questions.entries()) {
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(question, key)) {
        errors.push(`Question ${index + 1} missing ${key}`);
      }
    }
    const choices = [
      question["choices/c1"],
      question["choices/c2"],
      question["choices/c3"],
      question["choices/c4"]
    ].filter(Boolean);
    if (!choices.includes(question.answer)) {
      errors.push(`Question ${index + 1} answer is not in choices`);
    }
    if (question.img) {
      const imagePath = path.join(process.cwd(), question.img);
      if (!fs.existsSync(imagePath)) {
        errors.push(`Question ${index + 1} missing image ${question.img}`);
      }
    }
  }
  return errors;
}

function reportSkipped(flatNodes) {
  for (const node of flatNodes) {
    if (!node.href) continue;
    const reason = shouldSkipNode(node);
    if (reason) {
      state.skipped.push({
        title: node.title,
        type: node.type,
        path: pathString(node),
        href: canonicalElearningUrl(node.href),
        reason
      });
    }
  }
}

function writeReport({ questions, validationErrors, leafNodes, startTitle }) {
  const lines = [];
  lines.push("# LTO Portal Source Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Start page: ${START_URL}`);
  lines.push(`Start page title: ${startTitle}`);
  lines.push("");
  lines.push("## Schema");
  lines.push("");
  lines.push(
    "The output JSON is a top-level array matching data/drivesafe.ph.json: language, category, question, img, answer, and choices/c1 through choices/c4."
  );
  lines.push(
    "Image paths use the same app-root style as data/drivesafe.ph.json, for example data/portal.lto.gov.ph/images/stop-sign.png."
  );
  lines.push(
    "No source_url field was added because drivesafe.ph.json does not use one; source URLs are recorded in this report instead."
  );
  lines.push("");
  lines.push("## Scope Assumptions");
  lines.push("");
  lines.push(
    "- Included Driver's Manual roots relevant to Student Permit/new Non-Professional Driver's License review, general private-vehicle driving, road signs, pavement markings, road safety, registration, laws, and penalties."
  );
  lines.push(
    "- Excluded Driver's License Renewal Course/CDE content because it is a separate renewal course outside the Driver's Manual branch."
  );
  lines.push(
    "- Excluded Heavy Vehicle (C, CE, D), Professional CDE, Conductor's License, and franchise-only material as professional/commercial-only or not Non-Professional License reviewer content."
  );
  lines.push(
    "- The source does not expose a ready-made question bank in the followed public manual pages; reviewer questions were generated only from the official page text and image labels."
  );
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push(`- Questions created: ${questions.length}`);
  lines.push(`- Images downloaded: ${state.imageRecords.length}`);
  lines.push(`- Manual leaf pages followed: ${state.visited.length}`);
  lines.push(`- Relevant leaf links discovered from start page: ${leafNodes.length}`);
  lines.push(`- Cloudflare manual action: not required`);
  lines.push(`- Validation errors: ${validationErrors.length}`);
  if (validationErrors.length) {
    for (const error of validationErrors) lines.push(`  - ${error}`);
  }
  lines.push("");
  lines.push("## Source Pages Visited");
  lines.push("");
  for (const page of state.visited) {
    lines.push(`- ${page.path} [${page.type}]`);
    lines.push(`  ${page.url}`);
  }
  lines.push("");
  lines.push("## Followed Links/Resources From Driver's Manual Start Page");
  lines.push("");
  for (const item of state.followed) {
    lines.push(`- ${item.path} [${item.type}]`);
    lines.push(`  ${item.url}`);
  }
  lines.push("");
  lines.push("## Images Downloaded");
  lines.push("");
  for (const image of state.imageRecords) {
    lines.push(`- ${image.localPath} (${image.bytes} bytes)`);
    lines.push(`  ${image.sourceUrl}`);
  }
  lines.push("");
  lines.push("## Skipped Content");
  lines.push("");
  const uniqueSkipped = [];
  const seen = new Set();
  for (const item of state.skipped) {
    const key = `${item.path}|${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueSkipped.push(item);
  }
  for (const item of uniqueSkipped) {
    lines.push(`- ${item.path || item.title} [${item.type || "container"}]`);
    lines.push(`  Reason: ${item.reason}`);
    if (item.href) lines.push(`  ${item.href}`);
  }
  lines.push("");
  fs.writeFileSync(REPORT_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const startHtml = await fetchText(START_URL);
  const startDom = parseHtml(startHtml);
  const startTitle = cleanInline(
    textContent(findFirst(startDom, (node) => node.tag === "title")) || "LTMS eLearning"
  );
  const tree = parseTree(startDom);
  const flatNodes = flattenTree(tree);
  reportSkipped(flatNodes);
  const leafNodes = flatNodes.filter((node) => {
    if (!node.href || !node.type) return false;
    if (!/ELEARNING:(100|200|500):/i.test(node.href)) return false;
    return !shouldSkipNode(node);
  });
  const uniqueLeaves = [];
  const seenTopics = new Set();
  for (const node of leafNodes) {
    const key = `${node.type}|${topicIdFromUrl(canonicalElearningUrl(node.href))}`;
    if (seenTopics.has(key)) continue;
    seenTopics.add(key);
    uniqueLeaves.push(node);
  }
  const { pages, imageItems } = await collectPages(uniqueLeaves);
  const questions = buildQuestions(pages, imageItems);
  writeJson(questions);
  const validationErrors = validateQuestions(questions);
  writeReport({
    questions,
    validationErrors,
    leafNodes: uniqueLeaves,
    startTitle
  });
  if (validationErrors.length) {
    console.error(validationErrors.join("\n"));
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify(
      {
        questions: questions.length,
        images: state.imageRecords.length,
        pages: state.visited.length,
        json: JSON_PATH,
        report: REPORT_PATH
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
