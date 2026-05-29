"use strict";

const DB_NAME = "ltoMotorcycleReviewer";
const DB_VERSION = 1;
const DB_STORE = "questionBanks";
const DB_KEY = "np_motorcycle_questions";
const DEFAULT_QUESTION_BANK_URL = "data/questions.json";
const QUESTION_BANK_OPTIONS = [
  { label: "questions.json", url: "data/questions.json" },
  { label: "questions-v1.json", url: "data/questions-v1.json" },
  { label: "drivesafe.ph.json", url: "data/drivesafe.ph.json" },
  { label: "portal.lto.gov.ph.json", url: "data/portal.lto.gov.ph/portal.lto.gov.ph.json" }
];

const STORAGE_KEYS = {
  theme: "ltoMotorcycleTheme",
  settings: "ltoMotorcycleSettings",
  exam: "ltoMotorcycleExamState",
  questionBackup: "ltoMotorcycleQuestionBackup",
  questionMeta: "ltoMotorcycleQuestionMeta"
};

const app = document.getElementById("app");
const statusPanel = document.getElementById("statusPanel");
const themeChoiceButtons = Array.from(document.querySelectorAll("[data-theme-choice]"));

let questionBank = [];
let bankMeta = {
  source: "",
  savedAt: "",
  rawCount: 0
};
let examState = null;
let examTimerId = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
themeChoiceButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.themeChoice);
  });
});

async function initApp() {
  setupThemeButton();

  try {
    const loaded = await loadQuestionBank();
    questionBank = loaded.questions;
    bankMeta = loaded.meta;
    examState = loadExamState();

    if (!questionBank.length) {
      showStatus("No valid questions were found in questions.json. Check the file format and try again.", "error");
      renderStartScreen();
      return;
    }

    if (examState && examState.finished) {
      renderResults();
      return;
    }

    if (examState && examState.selectedQuestions && examState.selectedQuestions.length) {
      renderExam();
      return;
    }

    renderStartScreen();
  } catch (error) {
    console.error(error);
    showStatus(error.message || "Unable to load the question bank.", "error");
    renderStartScreen();
  }
}

function setupThemeButton() {
  const activeTheme = getActiveTheme();
  themeChoiceButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === activeTheme));
  });
}

function getActiveTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.classList.toggle("dark", nextTheme === "dark");
  document.documentElement.dataset.theme = nextTheme;
  try {
    localStorage.setItem(STORAGE_KEYS.theme, nextTheme);
  } catch (error) {
    console.warn("Theme save failed:", error);
  }
  setupThemeButton();
}

async function loadQuestionBank() {
  // Prefer IndexedDB so a returning user can load the reviewer without refetching questions.json.
  const indexedDbRecord = await readQuestionRecordFromIndexedDB();
  const indexedDbQuestions = getQuestionsFromStoredRecord(indexedDbRecord);
  if (indexedDbQuestions && indexedDbQuestions.length) {
    return {
      questions: normalizeQuestionBank(indexedDbQuestions),
      meta: {
        source: indexedDbRecord.source || "IndexedDB",
        url: normalizeQuestionBankUrl(indexedDbRecord.url || indexedDbRecord.source),
        savedAt: indexedDbRecord.savedAt || "",
        rawCount: indexedDbQuestions.length
      }
    };
  }

  const backupMeta = readQuestionMeta();
  const preferredBackupQuestions = backupMeta && backupMeta.preferBackup ? readQuestionBackup() : null;
  if (preferredBackupQuestions && preferredBackupQuestions.length) {
    return {
      questions: normalizeQuestionBank(preferredBackupQuestions),
      meta: {
        source: backupMeta.source || "selected JSON backup",
        url: normalizeQuestionBankUrl(backupMeta.url || backupMeta.source),
        savedAt: backupMeta.savedAt || "",
        rawCount: preferredBackupQuestions.length
      }
    };
  }

  try {
    // First successful load: fetch the default local JSON file, then keep a durable browser copy.
    const defaultOption = getQuestionBankOption(DEFAULT_QUESTION_BANK_URL);
    const rawList = await fetchQuestionBank(defaultOption.url);
    const savedAt = new Date().toISOString();
    await saveQuestionsToIndexedDB(rawList, {
      source: defaultOption.label,
      url: defaultOption.url,
      savedAt
    });
    saveQuestionBackup(rawList, {
      source: defaultOption.label,
      url: defaultOption.url,
      savedAt,
      preferBackup: false
    });

    return {
      questions: normalizeQuestionBank(rawList),
      meta: {
        source: defaultOption.label,
        url: defaultOption.url,
        savedAt,
        rawCount: rawList.length
      }
    };
  } catch (fetchError) {
    const backupQuestions = readQuestionBackup();
    if (backupQuestions && backupQuestions.length) {
      return {
        questions: normalizeQuestionBank(backupQuestions),
        meta: {
          source: backupMeta && backupMeta.source ? backupMeta.source : "localStorage backup",
          url: backupMeta && backupMeta.url ? normalizeQuestionBankUrl(backupMeta.url) : "",
          savedAt: backupMeta && backupMeta.savedAt ? backupMeta.savedAt : "",
          rawCount: backupQuestions.length
        }
      };
    }

    throw new Error("Could not load data/questions.json. If you opened the file directly, use a local static server so fetch can read the JSON file.");
  }
}

async function fetchQuestionBank(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(url + " returned " + response.status);
  }

  return extractQuestionList(await response.json());
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported in this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getQuestionsFromStoredRecord(record) {
  if (!record) {
    return null;
  }

  if (Array.isArray(record)) {
    return record;
  }

  if (record.questions) {
    return extractQuestionList(record.questions);
  }

  return null;
}

async function readQuestionRecordFromIndexedDB() {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const request = store.get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  } catch (error) {
    console.warn("IndexedDB read failed:", error);
    return null;
  }
}

async function saveQuestionsToIndexedDB(rawQuestions, meta = {}) {
  try {
    const db = await openDatabase();
    const savedAt = meta.savedAt || new Date().toISOString();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.put({
        id: DB_KEY,
        questions: rawQuestions,
        source: meta.source || getQuestionBankOption(DEFAULT_QUESTION_BANK_URL).label,
        url: normalizeQuestionBankUrl(meta.url || meta.source) || DEFAULT_QUESTION_BANK_URL,
        savedAt
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("IndexedDB save failed:", error);
  }
}

async function deleteQuestionDatabase() {
  if (!("indexedDB" in window)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("IndexedDB delete failed."));
    request.onblocked = () => reject(new Error("Could not replace the question bank because another tab is using the current IndexedDB database. Close other reviewer tabs and try again."));
  });
}

function saveQuestionBackup(rawQuestions, meta = null) {
  try {
    localStorage.setItem(STORAGE_KEYS.questionBackup, JSON.stringify(rawQuestions));
    if (meta) {
      localStorage.setItem(STORAGE_KEYS.questionMeta, JSON.stringify(meta));
    }
  } catch (error) {
    console.warn("Question backup save failed:", error);
  }
}

function readQuestionBackup() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.questionBackup);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn("Question backup read failed:", error);
    return null;
  }
}

function readQuestionMeta() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.questionMeta);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn("Question metadata read failed:", error);
    return null;
  }
}

function extractQuestionList(rawData) {
  if (Array.isArray(rawData)) {
    return rawData;
  }

  if (rawData && Array.isArray(rawData.questions)) {
    return rawData.questions;
  }

  throw new Error("questions.json must be an array or an object with a questions array.");
}

function getQuestionBankOption(url) {
  const normalizedUrl = normalizeQuestionBankUrl(url) || DEFAULT_QUESTION_BANK_URL;
  return QUESTION_BANK_OPTIONS.find((option) => option.url === normalizedUrl) || QUESTION_BANK_OPTIONS[0];
}

function normalizeQuestionBankUrl(value) {
  const cleanValue = cleanText(value);
  if (!cleanValue) {
    return "";
  }

  const normalizedValue = cleanValue.replace(/\\/g, "/").replace(/^\.\//, "");
  const matchedOption = QUESTION_BANK_OPTIONS.find((option) => {
    return normalizedValue === option.url ||
      normalizedValue === option.label ||
      normalizedValue === "data/" + option.label ||
      normalizedValue.endsWith("/" + option.label);
  });

  return matchedOption ? matchedOption.url : "";
}

function getCurrentQuestionBankUrl() {
  return normalizeQuestionBankUrl(bankMeta.url || bankMeta.source) || DEFAULT_QUESTION_BANK_URL;
}

function renderQuestionBankOptions(selectedUrl) {
  return QUESTION_BANK_OPTIONS.map((option) => {
    const selected = option.url === selectedUrl ? " selected" : "";
    return `<option value="${escapeAttribute(option.url)}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join("");
}

async function handleQuestionBankSelectChange(event) {
  const select = event.target;
  const nextUrl = normalizeQuestionBankUrl(select.value);
  const previousUrl = getCurrentQuestionBankUrl();
  if (!nextUrl || nextUrl === previousUrl) {
    return;
  }

  const option = getQuestionBankOption(nextUrl);
  showStatus("Loading " + option.label + "...", "info");

  try {
    await replaceQuestionBankFromUrl(option.url);
  } catch (error) {
    console.error(error);
    select.value = previousUrl;
    showStatus(error.message || "Could not load that JSON file.", "error");
  }
}

async function replaceQuestionBankFromUrl(url) {
  const option = getQuestionBankOption(url);
  const rawList = await fetchQuestionBank(option.url);
  const normalizedQuestions = normalizeQuestionBank(rawList);
  if (!normalizedQuestions.length) {
    throw new Error(option.label + " does not contain any usable questions.");
  }

  const savedAt = new Date().toISOString();
  await deleteQuestionDatabase();
  clearExamState();
  await saveQuestionsToIndexedDB(rawList, {
    source: option.label,
    url: option.url,
    savedAt
  });
  saveQuestionBackup(rawList, {
    source: option.label,
    url: option.url,
    savedAt,
    preferBackup: true
  });

  showStatus("Loaded " + normalizedQuestions.length + " usable questions from " + option.label + ". Refreshing...", "info");
  window.setTimeout(() => window.location.reload(), 350);
}

function normalizeQuestionBank(rawQuestions) {
  return extractQuestionList(rawQuestions)
    .map(normalizeQuestion)
    .filter(Boolean);
}

function normalizeQuestion(rawQuestion, index) {
  // The current bank uses choices/c1 keys; this also accepts common choices/options arrays.
  const question = cleanText(rawQuestion.question || rawQuestion.prompt || rawQuestion.text);
  const answer = cleanText(rawQuestion.answer || rawQuestion.correctAnswer || rawQuestion.correct_answer);
  const choices = getChoices(rawQuestion, answer);

  if (!question || !answer || choices.length < 2) {
    return null;
  }

  return {
    id: cleanText(rawQuestion.id) || buildQuestionId(rawQuestion, index),
    language: cleanText(rawQuestion.language || "all").toLowerCase(),
    category: cleanText(rawQuestion.category || "np_motorcycle"),
    question,
    image: cleanText(rawQuestion.img || rawQuestion.image || rawQuestion.imageUrl),
    answer,
    choices
  };
}

function getChoices(rawQuestion, answer) {
  let choices = [];

  if (Array.isArray(rawQuestion.choices)) {
    choices = rawQuestion.choices;
  } else if (Array.isArray(rawQuestion.options)) {
    choices = rawQuestion.options;
  } else if (rawQuestion.choices && typeof rawQuestion.choices === "object") {
    choices = Object.keys(rawQuestion.choices)
      .sort(sortChoiceKeys)
      .map((key) => rawQuestion.choices[key]);
  } else {
    choices = Object.keys(rawQuestion)
      .filter((key) => key.toLowerCase().startsWith("choices/"))
      .sort(sortChoiceKeys)
      .map((key) => rawQuestion[key]);
  }

  const cleanedChoices = choices.map(cleanText).filter(Boolean);
  if (answer && !cleanedChoices.includes(answer)) {
    cleanedChoices.push(answer);
  }

  return Array.from(new Set(cleanedChoices));
}

function sortChoiceKeys(a, b) {
  const numberA = parseInt(String(a).replace(/\D/g, ""), 10);
  const numberB = parseInt(String(b).replace(/\D/g, ""), 10);
  if (Number.isNaN(numberA) || Number.isNaN(numberB)) {
    return String(a).localeCompare(String(b));
  }
  return numberA - numberB;
}

function buildQuestionId(rawQuestion, index) {
  const base = [
    rawQuestion.language || "all",
    rawQuestion.category || "general",
    rawQuestion.question || "",
    index
  ].join("|");
  return "q_" + hashString(base);
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function cleanText(value) {
  return value == null ? "" : String(value).trim();
}

function renderStartScreen() {
  stopExamTimer();

  const settings = loadSettings();
  const counts = getLanguageCounts();
  const hasSavedExam = Boolean(examState && examState.selectedQuestions && examState.selectedQuestions.length);
  const availableForSelection = countAvailable(settings.language);
  const selectedQuestionBankUrl = getCurrentQuestionBankUrl();

  app.innerHTML = `
    <div class="grid gap-4">
      <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
        <div class="mb-5">
          <p class="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">Philippines Driver's License</p>
          <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">Motorcycle reviewer and mock exam</h2>
          <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-zinc-300">
            Choose a language, set your item count, and practice with randomized questions from your local question bank.
          </p>
        </div>

        <div class="grid gap-3 rounded-lg bg-slate-100 p-4 text-sm text-slate-700 dark:bg-zinc-950 dark:text-zinc-300 sm:grid-cols-3">
          <div>
            <span class="block text-xs uppercase tracking-wide text-slate-500 dark:text-zinc-500">Question bank</span>
            <strong class="text-slate-950 dark:text-zinc-50">${questionBank.length || 0} usable</strong>
          </div>
          <div>
            <span class="block text-xs uppercase tracking-wide text-slate-500 dark:text-zinc-500">English / Tagalog</span>
            <strong class="text-slate-950 dark:text-zinc-50">${counts.english || 0} / ${counts.tagalog || 0}</strong>
          </div>
          <div>
            <span class="block text-xs uppercase tracking-wide text-slate-500 dark:text-zinc-500">Loaded from</span>
            <strong class="text-slate-950 dark:text-zinc-50">${escapeHtml(bankMeta.source || "Not loaded")}</strong>
          </div>
        </div>

        <div class="mt-5 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 dark:border-zinc-700 dark:bg-zinc-950">
          <label class="grid gap-2">
            <span class="text-sm font-semibold">Question bank JSON</span>
            <select id="questionBankSelect" class="min-h-12 rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-950 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/25 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50">
              ${renderQuestionBankOptions(selectedQuestionBankUrl)}
            </select>
            <span class="text-sm text-slate-600 dark:text-zinc-400">Changing the selection replaces the saved question bank, clears saved exam progress, and refreshes the app.</span>
          </label>
        </div>

        ${hasSavedExam ? renderSavedExamNotice() : ""}

        <form id="startForm" class="mt-6 grid gap-5">
          <label class="grid gap-2">
            <span class="text-sm font-semibold">Language</span>
            <select id="languageSelect" class="min-h-12 rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-950 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/25 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50">
              <option value="english"${settings.language === "english" ? " selected" : ""}>English</option>
              <option value="tagalog"${settings.language === "tagalog" ? " selected" : ""}>Tagalog</option>
              <option value="all"${settings.language === "all" ? " selected" : ""}>All</option>
            </select>
          </label>

          <label class="grid gap-2">
            <span class="text-sm font-semibold">Number of items</span>
            <input id="itemCountInput" type="number" min="1" step="1" value="${settings.itemCount}" class="min-h-12 rounded-lg border border-slate-300 bg-white px-3 text-base text-slate-950 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/25 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50">
            <span id="availabilityNote" class="text-sm text-slate-600 dark:text-zinc-400">${getAvailabilityText(settings.language, settings.itemCount, availableForSelection)}</span>
          </label>

          <button type="submit" class="min-h-12 rounded-lg bg-teal-700 px-5 py-3 text-base font-bold text-white shadow-sm transition hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:bg-teal-500 dark:text-zinc-950 dark:hover:bg-teal-400">
            Start Exam
          </button>
        </form>
      </section>

      <section class="rounded-lg border border-slate-200 bg-white p-5 text-sm leading-6 text-slate-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
        <h3 class="mb-2 text-base font-bold text-slate-950 dark:text-zinc-50">Offline note</h3>
        <p>
          After a successful first load, the question bank is stored in IndexedDB and your exam progress is stored in browser storage. For local testing, use a simple static server because some browsers block <code class="rounded bg-slate-100 px-1 py-0.5 dark:bg-zinc-800">fetch("data/questions.json")</code> when opening HTML directly from the file system.
        </p>
      </section>
    </div>
  `;

  const languageSelect = document.getElementById("languageSelect");
  const itemCountInput = document.getElementById("itemCountInput");
  const availabilityNote = document.getElementById("availabilityNote");
  const questionBankSelect = document.getElementById("questionBankSelect");

  questionBankSelect.addEventListener("change", handleQuestionBankSelectChange);

  languageSelect.addEventListener("change", () => {
    const language = languageSelect.value;
    availabilityNote.textContent = getAvailabilityText(language, itemCountInput.value, countAvailable(language));
    saveSettings({
      language,
      itemCount: getRequestedItemCount(itemCountInput.value)
    });
  });

  itemCountInput.addEventListener("input", () => {
    availabilityNote.textContent = getAvailabilityText(languageSelect.value, itemCountInput.value, countAvailable(languageSelect.value));
    saveSettings({
      language: languageSelect.value,
      itemCount: getRequestedItemCount(itemCountInput.value)
    });
  });

  document.getElementById("startForm").addEventListener("submit", (event) => {
    event.preventDefault();
    startExam(languageSelect.value, getRequestedItemCount(itemCountInput.value));
  });

  const resumeButton = document.getElementById("resumeExamButton");
  if (resumeButton) {
    resumeButton.addEventListener("click", () => {
      hideStatus();
      renderExam();
    });
  }

  const discardButton = document.getElementById("discardExamButton");
  if (discardButton) {
    discardButton.addEventListener("click", () => {
      clearExamState();
      examState = null;
      renderStartScreen();
      showStatus("Saved exam cleared. You can start a new exam.", "info");
    });
  }
}

function renderSavedExamNotice() {
  const total = examState.selectedQuestions.length;
  const answered = examState.answers.filter(Boolean).length;
  const label = examState.finished ? "Finished exam saved" : "Saved exam in progress";

  return `
    <div class="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
      <div class="font-bold">${label}</div>
      <p class="mt-1">${answered} of ${total} items answered.</p>
      <div class="mt-3 flex flex-col gap-2 sm:flex-row">
        <button id="resumeExamButton" type="button" class="min-h-11 rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white transition hover:bg-blue-800 dark:bg-blue-500 dark:text-zinc-950 dark:hover:bg-blue-400">
          ${examState.finished ? "View Results" : "Resume Exam"}
        </button>
        <button id="discardExamButton" type="button" class="min-h-11 rounded-lg border border-blue-300 px-4 py-2 font-semibold text-blue-900 transition hover:bg-blue-100 dark:border-blue-700 dark:text-blue-100 dark:hover:bg-blue-900">
          Clear Saved Exam
        </button>
      </div>
    </div>
  `;
}

function startExam(language, requestedCount) {
  // Sampling from a shuffled copy prevents duplicate questions in the same exam session.
  const availableQuestions = filterQuestionsByLanguage(language);
  const selected = sampleWithoutDuplicates(availableQuestions, requestedCount)
    .map((question) => ({
      ...question,
      choices: shuffleArray(question.choices)
    }));

  if (!selected.length) {
    showStatus("No questions are available for that language.", "error");
    return;
  }

  const actualCount = selected.length;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs);
  examState = {
    id: startedAtMs.toString(),
    settings: {
      language,
      requestedCount,
      actualCount
    },
    selectedQuestions: selected,
    currentIndex: 0,
    answers: Array(actualCount).fill(null),
    startedAt: startedAt.toISOString(),
    startedAtMs,
    finished: false,
    submittedAt: null,
    submittedAtMs: null,
    durationSeconds: null,
    score: null
  };

  saveSettings({ language, itemCount: requestedCount });
  saveExamState();

  if (actualCount < requestedCount) {
    showStatus("Only " + actualCount + " matching questions are available, so the exam was shortened automatically.", "info");
  } else {
    hideStatus();
  }

  renderExam();
}

function renderExam() {
  if (!examState || !examState.selectedQuestions.length) {
    renderStartScreen();
    return;
  }

  if (examState.finished) {
    renderResults();
    return;
  }

  const total = examState.selectedQuestions.length;
  const currentIndex = clamp(examState.currentIndex, 0, total - 1);
  examState.currentIndex = currentIndex;
  const currentQuestion = examState.selectedQuestions[currentIndex];
  const selectedAnswer = examState.answers[currentIndex];
  const answeredCount = examState.answers.filter(Boolean).length;
  const progressPercent = Math.round(((currentIndex + 1) / total) * 100);
  const elapsedTime = formatDuration(getExamElapsedSeconds(examState));

  app.innerHTML = `
    <section class="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div class="border-b border-slate-200 p-4 dark:border-zinc-800 sm:p-5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="text-sm font-semibold text-teal-700 dark:text-teal-300">Question ${currentIndex + 1} of ${total}</p>
            <p class="text-xs text-slate-500 dark:text-zinc-400">${answeredCount} answered - Time: <span id="examElapsedTime">${elapsedTime}</span></p>
          </div>
          <button id="newExamButton" type="button" class="min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800">
            New Exam
          </button>
        </div>
        <div class="progress-track h-2">
          <div class="progress-fill" style="width: ${progressPercent}%"></div>
        </div>
      </div>

      <div class="p-4 sm:p-6">
        <div class="mb-4 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-wide">
          <span class="rounded-full bg-teal-100 px-3 py-1 text-teal-800 dark:bg-teal-950 dark:text-teal-200">${escapeHtml(currentQuestion.language)}</span>
          <span class="rounded-full bg-blue-100 px-3 py-1 text-blue-800 dark:bg-blue-950 dark:text-blue-200">${formatCategory(currentQuestion.category)}</span>
        </div>

        <h2 class="text-xl font-bold leading-snug sm:text-2xl">${escapeHtml(currentQuestion.question)}</h2>
        ${currentQuestion.image ? `<img src="${escapeAttribute(currentQuestion.image)}" alt="" class="mx-auto mt-4 block h-auto max-h-64 max-w-full rounded-lg border border-slate-200 object-contain dark:border-zinc-800">` : ""}

        <div class="mt-6 grid gap-3" role="radiogroup" aria-label="Answer choices">
          ${currentQuestion.choices.map((choice, choiceIndex) => renderChoiceButton(choice, choiceIndex, selectedAnswer)).join("")}
        </div>
      </div>

      <div class="grid gap-3 border-t border-slate-200 p-4 dark:border-zinc-800 sm:grid-cols-3 sm:p-5">
        <button id="previousButton" type="button" class="min-h-12 rounded-lg border border-slate-300 px-4 py-3 font-bold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800" ${currentIndex === 0 ? "disabled" : ""}>
          Previous
        </button>
        <button id="nextButton" type="button" class="min-h-12 rounded-lg border border-slate-300 px-4 py-3 font-bold text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800" ${currentIndex === total - 1 ? "disabled" : ""}>
          Next
        </button>
        <button id="submitButton" type="button" class="min-h-12 rounded-lg bg-teal-700 px-4 py-3 font-bold text-white shadow-sm transition hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-teal-500 dark:text-zinc-950 dark:hover:bg-teal-400" ${currentIndex !== total - 1 ? "disabled" : ""}>
          Submit
        </button>
      </div>
    </section>
  `;

  startExamTimer();

  document.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      chooseAnswer(button.dataset.choice);
    });
  });

  document.getElementById("previousButton").addEventListener("click", goToPreviousQuestion);
  document.getElementById("nextButton").addEventListener("click", goToNextQuestion);
  document.getElementById("submitButton").addEventListener("click", submitExam);
  document.getElementById("newExamButton").addEventListener("click", () => {
    if (window.confirm("Start a new exam and clear the current saved progress?")) {
      clearExamState();
      examState = null;
      hideStatus();
      renderStartScreen();
    }
  });
}

function renderChoiceButton(choice, choiceIndex, selectedAnswer) {
  const selected = choice === selectedAnswer;
  const letter = String.fromCharCode(65 + choiceIndex);

  return `
    <button type="button" class="choice-option flex min-h-14 w-full items-start gap-3 rounded-lg p-4 text-left" role="radio" aria-checked="${selected}" data-selected="${selected}" data-choice="${escapeAttribute(choice)}">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-700 dark:bg-zinc-800 dark:text-zinc-200">${letter}</span>
      <span class="leading-6">${escapeHtml(choice)}</span>
    </button>
  `;
}

function chooseAnswer(answer) {
  examState.answers[examState.currentIndex] = answer;
  saveExamState();
  hideStatus();
  renderExam();
}

function goToPreviousQuestion() {
  examState.currentIndex = Math.max(0, examState.currentIndex - 1);
  saveExamState();
  renderExam();
}

function goToNextQuestion() {
  if (!examState.answers[examState.currentIndex]) {
    showStatus("Select an answer before going to the next question.", "error");
    return;
  }

  hideStatus();
  examState.currentIndex = Math.min(examState.selectedQuestions.length - 1, examState.currentIndex + 1);
  saveExamState();
  renderExam();
}

function submitExam() {
  const unanswered = examState.answers.filter((answer) => !answer).length;
  if (unanswered > 0) {
    const shouldSubmit = window.confirm("You still have " + unanswered + " unanswered item" + (unanswered === 1 ? "" : "s") + ". Submit anyway?");
    if (!shouldSubmit) {
      return;
    }
  }

  const score = calculateScore(examState);
  const submittedAtMs = Date.now();
  const submittedAt = new Date(submittedAtMs);
  const durationSeconds = getExamElapsedSeconds(examState, submittedAtMs, { roundUp: true });
  examState.finished = true;
  examState.submittedAt = submittedAt.toISOString();
  examState.submittedAtMs = submittedAtMs;
  examState.durationSeconds = durationSeconds;
  examState.score = score;
  saveExamState();
  hideStatus();
  renderResults();
}

function calculateScore(state) {
  const total = state.selectedQuestions.length;
  let correct = 0;

  state.selectedQuestions.forEach((question, index) => {
    if (state.answers[index] === question.answer) {
      correct += 1;
    }
  });

  const wrong = total - correct;
  const percentage = total ? Math.round((correct / total) * 100) : 0;

  return {
    total,
    correct,
    wrong,
    percentage
  };
}

function startExamTimer() {
  stopExamTimer();
  updateExamTimerDisplay();
  examTimerId = window.setInterval(updateExamTimerDisplay, 1000);
}

function stopExamTimer() {
  if (!examTimerId) {
    return;
  }

  window.clearInterval(examTimerId);
  examTimerId = null;
}

function updateExamTimerDisplay() {
  const timer = document.getElementById("examElapsedTime");
  if (!timer || !examState || examState.finished) {
    return;
  }

  timer.textContent = formatDuration(getExamElapsedSeconds(examState));
}

function getExamElapsedSeconds(state, endDate = Date.now(), options = {}) {
  if (!state) {
    return 0;
  }

  const startedAtMs = getExamStartMs(state);
  const endMs = getExamEndMs(state, endDate);
  const savedDuration = state.durationSeconds == null ? NaN : Number(state.durationSeconds);

  if (Number.isFinite(startedAtMs) && Number.isFinite(endMs)) {
    const elapsedMs = Math.max(0, endMs - startedAtMs);
    const seconds = options.roundUp ? Math.ceil(elapsedMs / 1000) : Math.floor(elapsedMs / 1000);
    if (state.finished && Number.isFinite(savedDuration) && savedDuration >= 0) {
      return Math.max(seconds, Math.floor(savedDuration));
    }
    return Math.max(0, seconds);
  }

  if (state.finished && Number.isFinite(savedDuration) && savedDuration >= 0) {
    return Math.floor(savedDuration);
  }

  return 0;
}

function getExamStartMs(state) {
  const numericStartedAtMs = Number(state.startedAtMs);
  if (Number.isFinite(numericStartedAtMs) && numericStartedAtMs > 0) {
    return numericStartedAtMs;
  }

  const startedAtMs = Date.parse(state.startedAt);
  if (Number.isFinite(startedAtMs)) {
    return startedAtMs;
  }

  const idMs = Number(state.id);
  if (Number.isFinite(idMs) && idMs > 0) {
    return idMs;
  }

  return Date.now();
}

function getExamEndMs(state, fallbackEndDate) {
  if (state.finished) {
    const numericSubmittedAtMs = Number(state.submittedAtMs);
    if (Number.isFinite(numericSubmittedAtMs) && numericSubmittedAtMs > 0) {
      return numericSubmittedAtMs;
    }

    const submittedAtMs = Date.parse(state.submittedAt);
    if (Number.isFinite(submittedAtMs)) {
      return submittedAtMs;
    }
  }

  if (fallbackEndDate instanceof Date) {
    return fallbackEndDate.getTime();
  }

  const numericFallbackMs = Number(fallbackEndDate);
  if (Number.isFinite(numericFallbackMs) && numericFallbackMs > 0) {
    return numericFallbackMs;
  }

  return Date.parse(fallbackEndDate);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const paddedSeconds = String(remainingSeconds).padStart(2, "0");

  if (hours > 0) {
    return hours + ":" + String(minutes).padStart(2, "0") + ":" + paddedSeconds;
  }

  return minutes + ":" + paddedSeconds;
}

function renderResults() {
  stopExamTimer();

  if (!examState || !examState.selectedQuestions.length) {
    renderStartScreen();
    return;
  }

  const score = examState.score || calculateScore(examState);
  const duration = formatDuration(getExamElapsedSeconds(examState));

  app.innerHTML = `
    <section class="grid gap-4">
      <div class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-6">
        <p class="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">Exam Results</p>
        <h2 class="mt-2 text-3xl font-bold">${score.correct} / ${score.total}</h2>
        <p class="mt-1 text-slate-600 dark:text-zinc-300">${score.percentage}% score</p>

        <div class="mt-5 grid gap-3 sm:grid-cols-4">
          <div class="rounded-lg bg-green-50 p-4 text-green-900 dark:bg-green-950 dark:text-green-100">
            <span class="block text-xs uppercase tracking-wide">Correct</span>
            <strong class="text-2xl">${score.correct}</strong>
          </div>
          <div class="rounded-lg bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100">
            <span class="block text-xs uppercase tracking-wide">Wrong</span>
            <strong class="text-2xl">${score.wrong}</strong>
          </div>
          <div class="rounded-lg bg-blue-50 p-4 text-blue-900 dark:bg-blue-950 dark:text-blue-100">
            <span class="block text-xs uppercase tracking-wide">Items</span>
            <strong class="text-2xl">${score.total}</strong>
          </div>
          <div class="rounded-lg bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <span class="block text-xs uppercase tracking-wide">Duration</span>
            <strong class="text-2xl">${duration}</strong>
          </div>
        </div>

        <div class="mt-5 grid gap-3 sm:grid-cols-2">
          <button id="retakeButton" type="button" class="min-h-12 rounded-lg bg-teal-700 px-5 py-3 font-bold text-white transition hover:bg-teal-800 dark:bg-teal-500 dark:text-zinc-950 dark:hover:bg-teal-400">
            Start New Exam
          </button>
          <button id="reviewTopButton" type="button" class="min-h-12 rounded-lg border border-slate-300 px-5 py-3 font-bold text-slate-800 transition hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800">
            Review Answers
          </button>
        </div>
      </div>

      <div id="reviewList" class="grid gap-4">
        ${examState.selectedQuestions.map((question, index) => renderReviewQuestion(question, index)).join("")}
      </div>
    </section>
  `;

  document.getElementById("retakeButton").addEventListener("click", () => {
    clearExamState();
    examState = null;
    renderStartScreen();
  });

  document.getElementById("reviewTopButton").addEventListener("click", () => {
    document.getElementById("reviewList").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderReviewQuestion(question, index) {
  const selected = examState.answers[index];
  const isCorrect = selected === question.answer;

  return `
    <article class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-bold">Question ${index + 1}</h3>
        <span class="rounded-full px-3 py-1 text-xs font-bold ${isCorrect ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-100" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-100"}">
          ${isCorrect ? "Correct" : "Wrong"}
        </span>
      </div>
      <p class="mb-4 leading-6">${escapeHtml(question.question)}</p>
      ${question.image ? `<img src="${escapeAttribute(question.image)}" alt="" class="mx-auto mb-4 block h-auto max-h-56 max-w-full rounded-lg border border-slate-200 object-contain dark:border-zinc-800">` : ""}
      <div class="grid gap-2">
        ${question.choices.map((choice) => renderReviewChoice(choice, selected, question.answer)).join("")}
      </div>
      ${!isCorrect ? `<p class="mt-4 rounded-lg bg-slate-100 p-3 text-sm font-semibold text-slate-800 dark:bg-zinc-950 dark:text-zinc-100">Correct answer: ${escapeHtml(question.answer)}</p>` : ""}
    </article>
  `;
}

function renderReviewChoice(choice, selected, answer) {
  const isCorrectAnswer = choice === answer;
  const isWrongSelected = choice === selected && choice !== answer;
  const className = isCorrectAnswer ? "correct" : (isWrongSelected ? "wrong" : "");
  const marker = isCorrectAnswer ? "Correct answer" : (isWrongSelected ? "Your answer" : "");

  return `
    <div class="review-option ${className} rounded-lg p-3">
      <div class="flex items-start justify-between gap-3">
        <span class="leading-6">${escapeHtml(choice)}</span>
        ${marker ? `<span class="shrink-0 rounded-full bg-white/70 px-2 py-1 text-xs font-bold dark:bg-black/20">${marker}</span>` : ""}
      </div>
    </div>
  `;
}

function filterQuestionsByLanguage(language) {
  if (language === "all") {
    return questionBank;
  }
  return questionBank.filter((question) => question.language === language);
}

function countAvailable(language) {
  return filterQuestionsByLanguage(language).length;
}

function getLanguageCounts() {
  return questionBank.reduce((counts, question) => {
    counts[question.language] = (counts[question.language] || 0) + 1;
    return counts;
  }, {});
}

function getAvailabilityText(language, requestedCount, availableCount) {
  const requested = getRequestedItemCount(requestedCount);
  const languageLabel = language === "all" ? "all languages" : language;

  if (!availableCount) {
    return "No questions are available for " + languageLabel + ".";
  }

  if (requested > availableCount) {
    return "Only " + availableCount + " questions are available for " + languageLabel + "; the app will use all available questions.";
  }

  return availableCount + " questions available for " + languageLabel + ".";
}

function getRequestedItemCount(value) {
  const number = parseInt(value, 10);
  if (Number.isNaN(number) || number < 1) {
    return 60;
  }
  return number;
}

function sampleWithoutDuplicates(items, count) {
  return shuffleArray(items).slice(0, Math.min(count, items.length));
}

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function loadSettings() {
  const defaults = {
    language: "all",
    itemCount: 60
  };

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    return {
      language: stored && ["english", "tagalog", "all"].includes(stored.language) ? stored.language : defaults.language,
      itemCount: stored && stored.itemCount ? getRequestedItemCount(stored.itemCount) : defaults.itemCount
    };
  } catch (error) {
    return defaults;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (error) {
    console.warn("Settings save failed:", error);
  }
}

function loadExamState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.exam);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn("Exam state load failed:", error);
    return null;
  }
}

function saveExamState() {
  // localStorage keeps the active session small and easy to restore after refresh/reopen.
  try {
    localStorage.setItem(STORAGE_KEYS.exam, JSON.stringify(examState));
  } catch (error) {
    console.warn("Exam state save failed:", error);
    showStatus("Your browser could not save exam progress. You can continue in this tab, but refresh recovery may not work.", "error");
  }
}

function clearExamState() {
  localStorage.removeItem(STORAGE_KEYS.exam);
}

function showStatus(message, type) {
  const styles = {
    info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-100",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
  };

  statusPanel.className = "mb-4 rounded-lg border p-4 text-sm " + (styles[type] || styles.info);
  statusPanel.textContent = message;
  statusPanel.classList.remove("hidden");
}

function hideStatus() {
  statusPanel.classList.add("hidden");
  statusPanel.textContent = "";
}

function formatCategory(category) {
  return escapeHtml(category.replace(/_/g, " "));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
