(() => {
  "use strict";

  /* =========================================
     CONFIGURATION AND COMMON HELPERS
     ========================================= */

  const KEYS = {
    entries: "deardays_entries_v1",
    theme: "deardays_theme_v1",
    photos: "deardays_photo_memories_v1",
    settings: "deardays_custom_settings_v1"
  };

  const DB_NAME = "DearDaysMusicDB";
  const DB_VERSION = 2;
  const MUSIC_STORE = "tracks";
  const MEDIA_STORE = "media";

  const $ = (id) => document.getElementById(id);

  let toastTimer;
  let entries = loadData(KEYS.entries);
  let photos = loadData(KEYS.photos);
  let selectedDateFilter = "";
  let calendarMonth = new Date();
  let mediaObjectURLs = new Map();
  let currentMusicURL = null;
  let recorder = null;
  let recorderStream = null;
  let recorderChunks = [];

  function today() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function currentTime() {
    const date = new Date();
    return [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0")
    ].join(":");
  }

  function makeId() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function loadData(key) {
    try {
      const data = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error("Could not load saved data:", key, error);
      return [];
    }
  }

  function saveData(key, data, notify = true) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Could not save:", key, error);

      if (notify) {
        showToast("Browser storage full ho sakti hai. Kuch purana data remove karo.");
      }

      return false;
    }
  }

  function showToast(message) {
    const toast = $("toast");

    if (!toast) {
      window.alert(message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 2800);
  }

  function textElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(text ?? "");
    return node;
  }

  function formatDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "Date not set";
    }

    const [year, month, day] = value.split("-").map(Number);

    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function formatMonth(date) {
    return date.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric"
    });
  }

  function localDateFromParts(year, month, day) {
    return [
      year,
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-");
  }

  /* =========================================
     INDEXEDDB — SAVED MUSIC AND MEDIA FILES
     ========================================= */

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("Your browser does not support IndexedDB."));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(MUSIC_STORE)) {
          db.createObjectStore(MUSIC_STORE, { keyPath: "id" });
        }

        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);

      request.onerror = () => {
        reject(request.error || new Error("Could not open local database."));
      };
    });
  }

  async function dbPut(storeName, value) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      let transaction;

      try {
        transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }

      transaction.oncomplete = () => {
        db.close();
        resolve();
      };

      transaction.onerror = () => {
        const error = transaction.error;
        db.close();
        reject(error || new Error("Could not save this file."));
      };

      transaction.onabort = () => {
        const error = transaction.error;
        db.close();
        reject(error || new Error("Saving was cancelled."));
      };
    });
  }

  async function dbGet(storeName, id) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      let result = null;

      try {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(id);

        request.onsuccess = () => {
          result = request.result || null;
        };

        transaction.oncomplete = () => {
          db.close();
          resolve(result);
        };

        transaction.onerror = () => {
          const error = transaction.error;
          db.close();
          reject(error || new Error("Could not read saved data."));
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    });
  }

  async function dbGetAll(storeName) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).getAll();

        request.onsuccess = () => {
          // Store the result now; resolving happens at transaction completion.
          transaction._dearDaysResult = request.result || [];
        };

        transaction.oncomplete = () => {
          const result = transaction._dearDaysResult || [];
          db.close();
          resolve(result);
        };

        transaction.onerror = () => {
          const error = transaction.error;
          db.close();
          reject(error || new Error("Could not read the stored media."));
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    });
  }

  async function dbDelete(storeName, id) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(id);

        transaction.oncomplete = () => {
          db.close();
          resolve();
        };

        transaction.onerror = () => {
          const error = transaction.error;
          db.close();
          reject(error || new Error("Could not delete this item."));
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    });
  }

  /* =========================================
     PART 1 — THEMES AND CUSTOMIZATION
     ========================================= */

  const themeToggle = $("themeToggle");
  const themePreset = $("themePreset");
  const fontChoice = $("fontChoice");
  const backgroundChoice = $("backgroundChoice");

  function readSettings() {
    try {
      return JSON.parse(
        localStorage.getItem(KEYS.settings) || "{}"
      ) || {};
    } catch (error) {
      return {};
    }
  }

  function applySettings(settings) {
    const allowedThemes = ["classic", "blush", "sage", "lavender"];
    const allowedFonts = ["classic", "hand", "clean"];
    const allowedBackgrounds = ["paper", "grid", "plain"];

    const theme = allowedThemes.includes(settings.theme)
      ? settings.theme : "classic";

    const font = allowedFonts.includes(settings.font)
      ? settings.font : "classic";

    const background = allowedBackgrounds.includes(settings.background)
      ? settings.background : "paper";

    document.body.classList.remove(
      "theme-blush", "theme-sage", "theme-lavender",
      "font-hand", "font-clean", "bg-grid", "bg-plain"
    );

    if (theme !== "classic") {
      document.body.classList.add(`theme-${theme}`);
    }

    if (font !== "classic") {
      document.body.classList.add(`font-${font}`);
    }

    if (background !== "paper") {
      document.body.classList.add(`bg-${background}`);
    }

    if (themePreset) themePreset.value = theme;
    if (fontChoice) fontChoice.value = font;
    if (backgroundChoice) backgroundChoice.value = background;
  }

  function saveSettings() {
    saveData(KEYS.settings, {
      theme: themePreset?.value || "classic",
      font: fontChoice?.value || "classic",
      background: backgroundChoice?.value || "paper"
    }, false);
  }

  applySettings(readSettings());

  let savedDarkMode = "light";

  try {
    savedDarkMode = localStorage.getItem(KEYS.theme) || "light";
  } catch (error) {
    // Theme can still be changed for this visit.
  }

  function applyDarkMode(dark) {
    document.body.classList.toggle("dark", dark);

    if (themeToggle) {
      themeToggle.textContent = dark ? "☀" : "☾";
    }
  }

  applyDarkMode(savedDarkMode === "dark");

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const dark = !document.body.classList.contains("dark");
      applyDarkMode(dark);

      try {
        localStorage.setItem(KEYS.theme, dark ? "dark" : "light");
      } catch (error) {
        showToast("Theme will work until you close this page.");
      }
    });
  }

  [themePreset, fontChoice, backgroundChoice].forEach((control) => {
    if (!control) return;

    control.addEventListener("change", () => {
      saveSettings();
      applySettings(readSettings());
      showToast("Your diary style has been updated ♡");
    });
  });

  /* =========================================
     PART 2 — DIARY ENTRIES
     ========================================= */

  const entryForm = $("entryForm");
  const entryId = $("entryId");
  const titleInput = $("entryTitle");
  const dateInput = $("entryDate");
  const timeInput = $("entryTime");
  const moodInput = $("entryMood");
  const textInput = $("entryText");
  const entriesList = $("entriesList");
  const emptyState = $("emptyState");
  const searchInput = $("searchInput");
  const moodFilter = $("moodFilter");
  const favoritesOnly = $("favoritesOnly");
  const cancelEdit = $("cancelEdit");
  const formHeading = $("formHeading");
  const saveButton = $("saveButton");

  if (dateInput) dateInput.value = today();
  if (timeInput) timeInput.value = currentTime();

  function updateStats() {
    const entryCount = $("entryCount");
    const favouriteCount = $("favouriteCount");
    const todayMood = $("todayMood");

    if (entryCount) {
      entryCount.textContent = String(entries.length);
    }

    if (favouriteCount) {
      favouriteCount.textContent = String(
        entries.filter((item) => item.favorite).length
      );
    }

    const todaysEntries = entries
      .filter((item) => item.date === today())
      .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));

    if (todayMood) {
      todayMood.textContent = todaysEntries.length
        ? todaysEntries[0].mood || "Not set"
        : "Not yet";
    }
  }

  function resetEntryForm() {
    if (!entryForm) return;

    entryForm.reset();

    if (entryId) entryId.value = "";
    if (dateInput) dateInput.value = today();
    if (timeInput) timeInput.value = currentTime();

    if (formHeading) {
      formHeading.innerHTML = 'A page for today <span>✎</span>';
    }

    if (saveButton) {
      saveButton.textContent = "Save this page ♡";
    }

    if (cancelEdit) cancelEdit.classList.add("hidden");
  }

  function renderEntries() {
    if (!entriesList || !emptyState || !searchInput) return;

    entriesList.replaceChildren();

    const query = searchInput.value.trim().toLowerCase();
    const mood = moodFilter?.value || "all";
    const favorites = Boolean(favoritesOnly?.checked);

    const visibleEntries = entries
      .filter((entry) => {
        const searchable = [
          entry.title || "",
          entry.content || "",
          entry.mood || ""
        ].join(" ").toLowerCase();

        if (!searchable.includes(query)) return false;
        if (mood !== "all" && entry.mood !== mood) return false;
        if (favorites && !entry.favorite) return false;
        if (selectedDateFilter && entry.date !== selectedDateFilter) return false;

        return true;
      })
      .sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || "")) ||
        String(b.time || "").localeCompare(String(a.time || "")) ||
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );

    visibleEntries.forEach((entry) => {
      const card = document.createElement("article");
      card.className = "entry-card";

      card.append(
        textElement("div", "entry-date", formatDate(entry.date))
      );

      const heading = textElement("h3", "", entry.title || "Untitled memory");

      const time = textElement(
        "span",
        "entry-time",
        entry.time || ""
      );

      heading.appendChild(time);

      card.append(
        heading,
        textElement("span", "entry-mood", entry.mood || "😊 Happy"),
        textElement("p", "entry-content", entry.content || "")
      );

      const actions = textElement("div", "entry-actions", "");

      const edit = textElement("button", "small-action", "✎ Edit");
      edit.type = "button";
      edit.dataset.action = "edit";
      edit.dataset.id = entry.id;

      const remove = textElement("button", "small-action", "⌫ Delete");
      remove.type = "button";
      remove.dataset.action = "delete";
      remove.dataset.id = entry.id;

      const favorite = textElement(
        "button",
        `small-action fav${entry.favorite ? " is-fav" : ""}`,
        entry.favorite ? "♥" : "♡"
      );

      favorite.type = "button";
      favorite.dataset.action = "favorite";
      favorite.dataset.id = entry.id;

      actions.append(edit, remove, favorite);
      card.appendChild(actions);
      entriesList.appendChild(card);
    });

    const hasResults = visibleEntries.length > 0;
    emptyState.classList.toggle("hidden", hasResults);

    const emptyHeading = emptyState.querySelector("h3");
    const emptyText = emptyState.querySelector("p");

    if (!hasResults) {
      if (emptyHeading) emptyHeading.textContent = "No memories found";
      if (emptyText) {
        emptyText.textContent = "Try changing your search, mood or calendar date.";
      }
    } else {
      if (emptyHeading) emptyHeading.textContent = "Your story starts here";
      if (emptyText) {
        emptyText.textContent =
          "Write your first diary entry and watch your collection grow.";
      }
    }

    updateStats();
    renderCalendar();
    renderMoodHistory();
  }

  if (
    entryForm && entryId && titleInput && dateInput &&
    timeInput && moodInput && textInput && entriesList &&
    emptyState && searchInput
  ) {
    entryForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const title = titleInput.value.trim();
      const content = textInput.value.trim();

      if (!title || !content || !dateInput.value || !timeInput.value) {
        showToast("Title, date, time aur thoughts bharo.");
        return;
      }

      const previousEntries = entries.map((item) => ({ ...item }));
      const now = new Date().toISOString();
      const editingId = entryId.value;

      if (editingId) {
        const index = entries.findIndex((item) => item.id === editingId);

        if (index < 0) {
          showToast("Entry nahi mili. Please dobara try karo.");
          resetEntryForm();
          return;
        }

        entries[index] = {
          ...entries[index],
          title,
          content,
          date: dateInput.value,
          time: timeInput.value,
          mood: moodInput.value,
          updatedAt: now
        };
      } else {
        entries.push({
          id: makeId(),
          title,
          content,
          date: dateInput.value,
          time: timeInput.value,
          mood: moodInput.value,
          favorite: false,
          createdAt: now,
          updatedAt: now
        });
      }

      if (saveData(KEYS.entries, entries)) {
        resetEntryForm();
        renderEntries();
        showToast(editingId ? "Diary entry updated ♡" : "Memory saved ♡");
      } else {
        entries = previousEntries;
      }
    });

    entriesList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const entry = entries.find((item) => item.id === button.dataset.id);
      if (!entry) return;

      const action = button.dataset.action;

      if (action === "edit") {
        entryId.value = entry.id;
        titleInput.value = entry.title || "";
        dateInput.value = entry.date || today();
        timeInput.value = entry.time || currentTime();
        moodInput.value = entry.mood || "😊 Happy";
        textInput.value = entry.content || "";

        formHeading.innerHTML = 'Edit this memory <span>✎</span>';
        saveButton.textContent = "Update this page ♡";
        cancelEdit?.classList.remove("hidden");

        $("write").scrollIntoView({ behavior: "smooth" });
        titleInput.focus({ preventScroll: true });

      } else if (action === "delete") {
        if (!confirm(`Delete "${entry.title}"? This cannot be undone.`)) return;

        const previous = entries.map((item) => ({ ...item }));
        entries = entries.filter((item) => item.id !== entry.id);

        if (!saveData(KEYS.entries, entries)) {
          entries = previous;
          return;
        }

        if (entryId.value === entry.id) resetEntryForm();

        renderEntries();
        showToast("Diary entry deleted.");

      } else if (action === "favorite") {
        const previous = entry.favorite;
        entry.favorite = !entry.favorite;

        if (!saveData(KEYS.entries, entries)) {
          entry.favorite = previous;
          return;
        }

        renderEntries();
        showToast(entry.favorite ? "Added to favourites ♥" : "Removed from favourites");
      }
    });

    cancelEdit?.addEventListener("click", resetEntryForm);
    searchInput.addEventListener("input", renderEntries);
    moodFilter?.addEventListener("change", renderEntries);
    favoritesOnly?.addEventListener("change", renderEntries);
  }

  /* =========================================
     PART 3 — CALENDAR AND TIMELINE
     ========================================= */

  const calendarTitle = $("calendarTitle");
  const calendarDays = $("calendarDays");
  const calendarSelection = $("calendarSelection");

  function renderCalendar() {
    if (!calendarTitle || !calendarDays) return;

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();

    calendarTitle.textContent = formatMonth(calendarMonth);
    calendarDays.replaceChildren();

    const firstDay = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      const blank = document.createElement("button");
      blank.type = "button";
      blank.className = "calendar-day";
      blank.disabled = true;
      blank.setAttribute("aria-hidden", "true");
      calendarDays.appendChild(blank);
    }

    for (let day = 1; day <= totalDays; day++) {
      const dateString = localDateFromParts(year, month + 1, day);
      const dayEntries = entries.filter((entry) => entry.date === dateString);

      const button = textElement("button", "calendar-day", day);
      button.type = "button";
      button.dataset.date = dateString;

      if (dayEntries.length) button.classList.add("has-entries");
      if (dateString === today()) button.classList.add("today");
      if (dateString === selectedDateFilter) button.classList.add("selected");

      button.setAttribute(
        "aria-label",
        `${formatDate(dateString)}${dayEntries.length ? `, ${dayEntries.length} entries` : ""}`
      );

      button.addEventListener("click", () => {
        selectedDateFilter = dateString;

        if (calendarSelection) {
          calendarSelection.textContent = `Showing: ${formatDate(dateString)}`;
        }

        renderEntries();
      });

      calendarDays.appendChild(button);
    }

    if (calendarSelection) {
      calendarSelection.textContent = selectedDateFilter
        ? `Showing: ${formatDate(selectedDateFilter)}`
        : "Showing all dates";
    }
  }

  $("prevMonth")?.addEventListener("click", () => {
    calendarMonth = new Date(
      calendarMonth.getFullYear(),
      calendarMonth.getMonth() - 1,
      1
    );
    renderCalendar();
  });

  $("nextMonth")?.addEventListener("click", () => {
    calendarMonth = new Date(
      calendarMonth.getFullYear(),
      calendarMonth.getMonth() + 1,
      1
    );
    renderCalendar();
  });

  $("clearDateFilter")?.addEventListener("click", () => {
    selectedDateFilter = "";
    renderEntries();
  });

  /* =========================================
     PART 4 — MOOD HISTORY
     ========================================= */

  function renderMoodHistory() {
    const container = $("moodHistory");
    if (!container) return;

    container.replaceChildren();

    const sorted = [...entries]
      .sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || "")) ||
        String(b.time || "").localeCompare(String(a.time || ""))
      )
      .slice(0, 12);

    if (!sorted.length) {
      container.appendChild(
        textElement("p", "privacy-note", "Your saved moods will appear here.")
      );
      return;
    }

    sorted.forEach((entry) => {
      const card = textElement("article", "mood-history-card", "");

      card.append(
        textElement("strong", "", formatDate(entry.date)),
        textElement("span", "", entry.mood || "Mood not set"),
        textElement("p", "", entry.title || "Untitled memory")
      );

      container.appendChild(card);
    });
  }

  /* =========================================
     PART 5 — PHOTO MEMORIES
     Keeps the existing photo storage key
     ========================================= */

  const photoForm = $("photoForm");
  const photoFile = $("photoFile");
  const photoCaption = $("photoCaption");
  const photoDate = $("photoDate");
  const photoGallery = $("photoGallery");
  const photoEmpty = $("photoEmpty");

  if (photoDate) photoDate.value = today();

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(new Error("Could not read photo."));

      reader.onload = () => {
        const image = new Image();

        image.onerror = () => reject(new Error("Invalid image."));

        image.onload = () => {
          const maxSide = 1000;
          const scale = Math.min(
            1,
            maxSide / Math.max(image.width, image.height)
          );

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));

          const context = canvas.getContext("2d");

          if (!context) {
            reject(new Error("Could not process image."));
            return;
          }

          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.75));
        };

        image.src = reader.result;
      };

      reader.readAsDataURL(file);
    });
  }

  function renderPhotos() {
    if (!photoGallery || !photoEmpty) return;

    photoGallery.replaceChildren();

    photos.forEach((photo) => {
      if (!photo || !photo.image) return;

      const card = textElement("article", "photo-card", "");

      const image = document.createElement("img");
      image.src = photo.image;
      image.alt = photo.caption || "Photo memory";
      image.loading = "lazy";

      const title = textElement("h3", "", photo.caption || "Little memory");
      const date = document.createElement("time");
      date.textContent = formatDate(photo.date);

      const remove = textElement("button", "photo-remove", "Remove memory");
      remove.type = "button";

      remove.addEventListener("click", () => {
        if (!confirm(`Remove "${photo.caption}"?`)) return;

        const previous = photos;
        photos = photos.filter((item) => item.id !== photo.id);

        if (saveData(KEYS.photos, photos)) {
          renderPhotos();
          showToast("Photo memory removed.");
        } else {
          photos = previous;
        }
      });

      card.append(image, title, date, remove);
      photoGallery.appendChild(card);
    });

    photoEmpty.hidden = photos.length > 0;
  }

  if (photoForm && photoFile && photoCaption && photoDate) {
    photoForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const file = photoFile.files?.[0];
      const caption = photoCaption.value.trim();
      const date = photoDate.value;

      if (!file || !caption || !date) {
        showToast("Photo, caption aur date bharo.");
        return;
      }

      if (!file.type.startsWith("image/")) {
        showToast("Choose a valid image.");
        return;
      }

      if (file.size > 12 * 1024 * 1024) {
        showToast("12 MB se chhoti photo choose karo.");
        return;
      }

      const submitButton = photoForm.querySelector('button[type="submit"]');
      const oldText = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";

      try {
        const imageData = await compressImage(file);
        const previous = photos;

        photos = [{
          id: makeId(),
          caption,
          date,
          image: imageData
        }, ...photos];

        if (saveData(KEYS.photos, photos, false)) {
          renderPhotos();
          photoForm.reset();
          photoDate.value = today();
          showToast("Photo memory saved ♡");
        } else {
          photos = previous;
          showToast("Storage full ho sakti hai. Kuch purani photos remove karo.");
        }
      } catch (error) {
        console.error(error);
        showToast("Photo save nahi hui. Doosri photo try karo.");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = oldText;
      }
    });

    renderPhotos();
  }

  /* =========================================
     PART 6 — VIDEO MEMORIES
     ========================================= */

  const videoForm = $("videoForm");
  const videoFile = $("videoFile");
  const videoCaption = $("videoCaption");
  const videoDate = $("videoDate");
  const videoGallery = $("videoGallery");

  if (videoDate) videoDate.value = today();

  function clearMediaObjectURLs() {
    for (const url of mediaObjectURLs.values()) {
      URL.revokeObjectURL(url);
    }

    mediaObjectURLs.clear();
  }

  function createStoredMediaCard(item) {
    const card = textElement("article", "media-card", "");
    const objectURL = URL.createObjectURL(item.blob);
    mediaObjectURLs.set(item.id, objectURL);

    if (item.kind === "video") {
      const video = document.createElement("video");
      video.src = objectURL;
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      video.setAttribute("aria-label", item.caption || "Saved video");

      card.appendChild(video);
    } else if (item.kind === "voice") {
      const audio = document.createElement("audio");
      audio.src = objectURL;
      audio.controls = true;
      audio.preload = "metadata";
      audio.style.width = "100%";

      card.appendChild(audio);
    }

    card.append(
      textElement("h3", "", item.caption || "Memory"),
      textElement("time", "", formatDate(item.date))
    );

    const remove = textElement("button", "photo-remove", "Remove memory");
    remove.type = "button";

    remove.addEventListener("click", async () => {
      if (!confirm(`Remove "${item.caption || "this memory"}"?`)) return;

      try {
        await dbDelete(MEDIA_STORE, item.id);
        await renderStoredMedia();
        showToast("Media memory removed.");
      } catch (error) {
        console.error(error);
        showToast("Could not delete this memory.");
      }
    });

    card.appendChild(remove);
    return card;
  }

  async function renderStoredMedia() {
    if (!videoGallery || !$("voiceGallery")) return;

    clearMediaObjectURLs();
    videoGallery.replaceChildren();
    $("voiceGallery").replaceChildren();

    try {
      const saved = await dbGetAll(MEDIA_STORE);

      saved
        .filter((item) => item.kind === "video")
        .forEach((item) => {
          videoGallery.appendChild(createStoredMediaCard(item));
        });

      saved
        .filter((item) => item.kind === "voice")
        .forEach((item) => {
          $("voiceGallery").appendChild(createStoredMediaCard(item));
        });
    } catch (error) {
      console.error(error);
      showToast("Saved media could not be loaded.");
    }
  }

  if (videoForm && videoFile && videoCaption && videoDate) {
    videoForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const file = videoFile.files?.[0];
      const caption = videoCaption.value.trim();
      const date = videoDate.value;

      if (!file || !caption || !date) {
        showToast("Video, caption aur date bharo.");
        return;
      }

      if (!file.type.startsWith("video/")) {
        showToast("Choose a valid video file.");
        return;
      }

      if (file.size > 50 * 1024 * 1024) {
        showToast("Please choose a video smaller than 50 MB.");
        return;
      }

      const button = $("saveVideoButton");
      button.disabled = true;
      button.textContent = "Saving video...";

      try {
        await dbPut(MEDIA_STORE, {
          id: makeId(),
          kind: "video",
          caption,
          date,
          name: file.name,
          type: file.type,
          blob: file
        });

        await renderStoredMedia();
        videoForm.reset();
        videoDate.value = today();
        showToast("Video memory saved ♡");
      } catch (error) {
        console.error(error);
        showToast("Video could not be saved. Browser storage may be full.");
      } finally {
        button.disabled = false;
        button.textContent = "Save video ♡";
      }
    });
  }

  /* =========================================
     PART 7 — VOICE RECORDING
     Requires microphone permission
     ========================================= */

  const startRecording = $("startRecording");
  const stopRecording = $("stopRecording");
  const voiceStatus = $("voiceStatus");

  function stopMicrophoneTracks() {
    if (recorderStream) {
      recorderStream.getTracks().forEach((track) => track.stop());
      recorderStream = null;
    }
  }

  if (startRecording && stopRecording && voiceStatus) {
    startRecording.addEventListener("click", async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        showToast("Voice recording is not supported in this browser.");
        return;
      }

      startRecording.disabled = true;
      voiceStatus.textContent = "Requesting microphone permission...";

      try {
        recorderStream = await navigator.mediaDevices.getUserMedia({
          audio: true
        });

        let options = {};

        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          options.mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          options.mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          options.mimeType = "audio/mp4";
        }

        recorder = new MediaRecorder(recorderStream, options);
        recorderChunks = [];

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recorderChunks.push(event.data);
          }
        };

        recorder.onstop = async () => {
          stopMicrophoneTracks();

          const blob = new Blob(recorderChunks, {
            type: recorder.mimeType || "audio/webm"
          });

          if (!blob.size) {
            voiceStatus.textContent = "No audio was recorded.";
            return;
          }

          try {
            await dbPut(MEDIA_STORE, {
              id: makeId(),
              kind: "voice",
              caption: `Voice memory · ${currentTime()}`,
              date: today(),
              name: `Voice memory ${currentTime()}`,
              type: blob.type,
              blob
            });

            await renderStoredMedia();
            voiceStatus.textContent = "Voice memory saved successfully ♡";
            showToast("Voice memory saved ♡");
          } catch (error) {
            console.error(error);
            voiceStatus.textContent = "Could not save the recording.";
            showToast("Recording save nahi hui. Browser storage check karo.");
          } finally {
            startRecording.disabled = false;
            stopRecording.disabled = true;
          }
        };

        recorder.onerror = () => {
          stopMicrophoneTracks();
          startRecording.disabled = false;
          stopRecording.disabled = true;
          voiceStatus.textContent = "Recording error. Please try again.";
        };

        recorder.start();

        voiceStatus.textContent = "Recording... press Stop & save when finished.";
        startRecording.disabled = true;
        stopRecording.disabled = false;
      } catch (error) {
        console.error(error);
        stopMicrophoneTracks();

        startRecording.disabled = false;
        stopRecording.disabled = true;

        voiceStatus.textContent =
          "Microphone permission was not granted or is unavailable.";
      }
    });

    stopRecording.addEventListener("click", () => {
      if (recorder && recorder.state === "recording") {
        stopRecording.disabled = true;
        voiceStatus.textContent = "Saving your voice memory...";
        recorder.stop();
      }
    });
  }

  /* =========================================
     PART 8 — MUSIC PLAYER
     Persists the selected song in IndexedDB
     ========================================= */

  const musicFile = $("musicFile");
  const musicAudio = $("musicAudio");
  const musicPlay = $("musicPlay");
  const musicStop = $("musicStop");
  const musicChoose = $("musicChoose");
  const musicRecord = $("musicRecord");
  const musicTrackName = $("musicTrackName");

  function setMusicSource(blob, name) {
    musicAudio.pause();

    if (currentMusicURL) {
      URL.revokeObjectURL(currentMusicURL);
    }

    currentMusicURL = URL.createObjectURL(blob);
    musicAudio.src = currentMusicURL;
    musicTrackName.textContent = name || "Your favourite song";
    musicAudio.load();

    updateMusicPlayer();
  }

  function updateMusicPlayer() {
    if (!musicAudio || !musicPlay || !musicRecord) return;

    const playing = !musicAudio.paused && !musicAudio.ended;

    musicPlay.textContent = playing ? "Ⅱ" : "▶";
    musicPlay.setAttribute(
      "aria-label",
      playing ? "Pause music" : "Play music"
    );

    musicRecord.classList.toggle("spinning", playing);
  }

  async function restoreMusic() {
    try {
      const song = await dbGet(MUSIC_STORE, "current-song");

      if (song?.blob) {
        setMusicSource(song.blob, song.name);
      }
    } catch (error) {
      console.error("Could not restore music:", error);
    }
  }

  if (
    musicFile && musicAudio && musicPlay && musicStop &&
    musicChoose && musicRecord && musicTrackName
  ) {
    musicChoose.addEventListener("click", () => {
      musicFile.value = "";
      musicFile.click();
    });

    musicFile.addEventListener("change", async () => {
      const file = musicFile.files?.[0];
      if (!file) return;

      if (file.type && !file.type.startsWith("audio/")) {
        showToast("Please select an audio file.");
        return;
      }

      musicChoose.disabled = true;
      musicPlay.disabled = true;
      musicTrackName.textContent = "Saving song...";

      try {
        await dbPut(MUSIC_STORE, {
          id: "current-song",
          name: file.name,
          type: file.type || "audio/mpeg",
          blob: file,
          savedAt: new Date().toISOString()
        });

        setMusicSource(file, file.name);

        try {
          await musicAudio.play();
          showToast("Song saved and playing ♡");
        } catch (error) {
          showToast("Song saved! Press Play to listen.");
        }
      } catch (error) {
        console.error(error);
        musicTrackName.textContent = "Could not save song";
        showToast("Song could not be saved. Browser storage may be full.");
      } finally {
        musicChoose.disabled = false;
        musicPlay.disabled = false;
        musicFile.value = "";
        updateMusicPlayer();
      }
    });

    musicPlay.addEventListener("click", async () => {
      if (!musicAudio.src) {
        musicFile.click();
        return;
      }

      try {
        if (musicAudio.paused) {
          await musicAudio.play();
        } else {
          musicAudio.pause();
        }
      } catch (error) {
        showToast("Music play nahi hua. Dobara try karo.");
      }

      updateMusicPlayer();
    });

    musicStop.addEventListener("click", () => {
      musicAudio.pause();

      if (musicAudio.src) {
        try {
          musicAudio.currentTime = 0;
        } catch (error) {
          // Song may still be loading.
        }
      }

      updateMusicPlayer();
    });

    musicAudio.addEventListener("play", updateMusicPlayer);
    musicAudio.addEventListener("pause", updateMusicPlayer);
    musicAudio.addEventListener("ended", updateMusicPlayer);

    musicAudio.addEventListener("error", () => {
      showToast("This audio file could not be played.");
      updateMusicPlayer();
    });

    restoreMusic();
  }

  /* =========================================
     INITIAL RENDER
     ========================================= */

  renderCalendar();
  renderMoodHistory();
  renderStoredMedia();
  renderPhotos();
  updateStats();

  window.addEventListener("beforeunload", () => {
    if (currentMusicURL) {
      URL.revokeObjectURL(currentMusicURL);
    }

    clearMediaObjectURLs();
    stopMicrophoneTracks();
  });

})();