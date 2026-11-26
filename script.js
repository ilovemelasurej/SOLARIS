(function () {
    const DB_URL = "https://solaris-1c-default-rtdb.firebaseio.com";
    const SENSOR_REFRESH_INTERVAL_MS = 2000;
    const REQUEST_TIMEOUT_MS = 5000;

    // Measured 1-dripper rate from 20s test (~20.5-22.3 mL => ~1.07 mL/s => ~64.2 mL/min => ~0.0642 L/min)
    const DRIPPER_ML_PER_SEC = 1.07;
    const DRIPPER_ML_PER_MIN = DRIPPER_ML_PER_SEC * 60;
    const DRIPPER_L_PER_MIN = DRIPPER_ML_PER_MIN / 1000;

    const PLANT_PROFILES = {
        Kalamansi: {
            Indoor: { optimalTime: "06:00", intervalHours: 36, optimalLiters: 0.35 },
            Outdoor: { optimalTime: "06:00", intervalHours: 24, optimalLiters: 0.50 }
        },
        Oregano: {
            Indoor: { optimalTime: "06:30", intervalHours: 72, optimalLiters: 0.18 },
            Outdoor: { optimalTime: "06:30", intervalHours: 48, optimalLiters: 0.25 }
        }
    };

const AMBIENT_TRACKS = {
        outdoor_daylight: { file: "Outdoor daylight and sunset.mp3", label: "Outdoor Daylight" },
        outdoor_sunset:   { file: "Outdoor daylight and sunset.mp3", label: "Outdoor Sunset" },
        outdoor_rain:     { file: "Outdoor raining.mp3",              label: "Outdoor Rain" },
        outdoor_night:    { file: "outdoor night.mp3",                label: "Outdoor Night" },

        indoor_daylight:  { file: "Indoor daylight and sunset.mp3",  label: "Indoor Daylight" },
        indoor_sunset:    { file: "Indoor daylight and sunset.mp3",  label: "Indoor Sunset" },
        indoor_rain:      { file: "Indoor raining.mp3",               label: "Indoor Rain" },
        indoor_night:     { file: "Indoor night.mp3",                 label: "Indoor Night" }
    };

    function showNotice(title, message) {
        const dlg = document.querySelector("#noticeDialog");
        const tEl = document.querySelector("#noticeTitle");
        const mEl = document.querySelector("#noticeMessage");
        if (tEl) tEl.textContent = title;
        if (mEl) mEl.textContent = message;
        if (dlg && typeof dlg.showModal === "function") dlg.showModal();
        else if (dlg) dlg.setAttribute("open", "");
    }

    document.querySelector("#closeNoticeBtn")?.addEventListener("click", () => {
        const dlg = document.querySelector("#noticeDialog");
        if (dlg && typeof dlg.close === "function") dlg.close();
        else if (dlg) dlg.removeAttribute("open");
    });

    const page2BgMusic = document.querySelector("#bgMusic");
    const audioSink = document.querySelector("#hiddenAudioSink");
    const isStandaloneMonitoring = Boolean(page2BgMusic);

    // ===================== VIEW ROUTER (SPA) =====================
    function getActiveRouteView() {
        if (isStandaloneMonitoring) return "monitoring";
        const hash = (window.location.hash || "").toLowerCase();
        if (hash === "#monitoring" || hash === "#/monitoring") return "monitoring";
        return "config";
    }

    function applyRouteView(routeName) {
        if (isStandaloneMonitoring) {
            document.body.classList.add("view-monitoring");
            document.body.classList.remove("view-config");
            updateScrollRootsProgress();
            updateDashboardFromFirebase();
            return;
        }

        const isMonitoring = routeName === "monitoring";
        document.body.classList.toggle("view-monitoring", isMonitoring);
        document.body.classList.toggle("view-config", !isMonitoring);
        if (!isMonitoring) {
            window.scrollTo(0, 0);
            document.documentElement.style.setProperty("--scroll-progress", "0");
        } else {
            updateScrollRootsProgress();
            updateDashboardFromFirebase();
        }
        applyTrackToPlayer(false);
    }

    window.addEventListener("hashchange", () => applyRouteView(getActiveRouteView()));

    // ===================== SCENERY & SPECIES STATE =====================
    let currentScenery = localStorage.getItem("configuredScenery") || "daylight";
    let currentEnvironment = localStorage.getItem("configuredEnvironment") || "Indoor";
    let currentPlant = localStorage.getItem("configuredPlant") || "Kalamansi";
    let latestSoilMoisturePct = null;
    let manualOpenStartedAtMs = null;
    let lastClearedExpiredId = "";

    function resolveAmbientTrack() {
        const isOutdoor = String(currentEnvironment).toLowerCase() === "outdoor";
        const envKey = isOutdoor ? "outdoor" : "indoor";
        const moodKey = ["daylight", "sunset", "night", "rain"].includes(currentScenery)
            ? currentScenery
            : "daylight";
        return AMBIENT_TRACKS[`${envKey}_${moodKey}`] || AMBIENT_TRACKS.indoor_daylight;
    }

    // ===================== AUDIO CONTROLLER =====================
    let currentLoadedFile = "";
    let userAudioUnlocked = false;
    let desiredPlaying = localStorage.getItem("solarisMusicPlaying") !== "false";

    if (audioSink) {
        audioSink.volume = 0.65;
        audioSink.loop = true;
        audioSink.preload = "auto";
    }

    if (page2BgMusic) {
        page2BgMusic.volume = 0.65;
        page2BgMusic.loop = true;
        page2BgMusic.preload = "auto";
    }

    function saveMusicState(forcePlaying = null) {
        if (!page2BgMusic) return;
        try {
            localStorage.setItem("solarisMusicTime", String(page2BgMusic.currentTime || 0));
            const isPlaying = forcePlaying !== null ? forcePlaying : !page2BgMusic.paused;
            localStorage.setItem("solarisMusicPlaying", isPlaying ? "true" : "false");
            localStorage.setItem("solarisMusicMuted", page2BgMusic.muted ? "true" : "false");
        } catch (_) {}
    }

    function syncAudioButtonsUI(isPlaying) {
        const btns = document.querySelectorAll(".audio-pill-btn");
        if (isStandaloneMonitoring) {
            btns.forEach((btn) => {
                btn.classList.toggle("is-playing", Boolean(isPlaying));
                const labelEl = btn.querySelector(".audio-label");
                if (labelEl) {
                    labelEl.textContent = isPlaying ? "music2.mp3 · Playing" : "music2.mp3 · Tap Audio";
                }
            });
            return;
        }

        const track = resolveAmbientTrack();
        btns.forEach((btn) => {
            btn.classList.toggle("is-playing", Boolean(isPlaying));
            const labelEl = btn.querySelector(".audio-label");
            if (labelEl) {
                labelEl.textContent = isPlaying
                    ? `${track.label} · Playing`
                    : `${track.label} · Tap Audio`;
            }
        });
    }

    function playAudioElement(el) {
        if (!el) return Promise.resolve(false);
        el.muted = false;
        if (el.volume === 0) el.volume = 0.65;
        const p = el.play();
        if (p && typeof p.then === "function") {
            return p.then(() => true).catch(() => false);
        }
        return Promise.resolve(!el.paused);
    }

    function applyTrackToPlayer(forcePlay = false) {
        if (isStandaloneMonitoring) {
            if (forcePlay) {
                desiredPlaying = true;
                userAudioUnlocked = true;
            }
            if (desiredPlaying && userAudioUnlocked) {
                playAudioElement(page2BgMusic).then((ok) => {
                    syncAudioButtonsUI(ok);
                    saveMusicState(ok);
                });
            } else {
                syncAudioButtonsUI(Boolean(page2BgMusic && !page2BgMusic.paused && !page2BgMusic.muted));
            }
            return;
        }

        const track = resolveAmbientTrack();
        const nextFile = track.file;
        const fileChanged = nextFile !== currentLoadedFile;

        if (forcePlay) {
            desiredPlaying = true;
            userAudioUnlocked = true;
        }

        if (!audioSink) {
            syncAudioButtonsUI(false);
            return;
        }

        if (fileChanged || !audioSink.getAttribute("src")) {
            currentLoadedFile = nextFile;
            audioSink.src = encodeURI(nextFile);
            audioSink.load();
        }

        if (desiredPlaying && userAudioUnlocked) {
            playAudioElement(audioSink).then((ok) => {
                syncAudioButtonsUI(ok);
            });
        } else {
            syncAudioButtonsUI(Boolean(audioSink && !audioSink.paused && !audioSink.muted && currentLoadedFile));
        }
    }

    function unlockOrToggleAmbientAudio(forcePlayOnly = false) {
        userAudioUnlocked = true;

        if (isStandaloneMonitoring) {
            if (!forcePlayOnly && page2BgMusic && !page2BgMusic.paused && !page2BgMusic.muted) {
                desiredPlaying = false;
                page2BgMusic.pause();
                syncAudioButtonsUI(false);
                saveMusicState(false);
                return;
            }
            desiredPlaying = true;
            applyTrackToPlayer(true);
            return;
        }

        if (!forcePlayOnly && audioSink && !audioSink.paused && !audioSink.muted) {
            desiredPlaying = false;
            audioSink.pause();
            syncAudioButtonsUI(false);
            return;
        }

        desiredPlaying = true;
        applyTrackToPlayer(true);
    }

    document.querySelectorAll(".audio-pill-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            unlockOrToggleAmbientAudio(false);
        });
    });

    function handleScreenTapAudioUnlock() {
        if (!userAudioUnlocked) {
            unlockOrToggleAmbientAudio(true);
        } else if (desiredPlaying) {
            const activeEl = isStandaloneMonitoring ? page2BgMusic : audioSink;
            if (activeEl && (activeEl.paused || activeEl.muted)) {
                applyTrackToPlayer(true);
            }
        }
    }

    ["pointerdown", "click", "touchstart"].forEach((evtName) => {
        document.addEventListener(evtName, handleScreenTapAudioUnlock, { passive: true });
    });
    document.addEventListener("keydown", handleScreenTapAudioUnlock, { passive: true });

    audioSink?.addEventListener("play", () => {
        if (!audioSink.muted) syncAudioButtonsUI(true);
    });
    audioSink?.addEventListener("pause", () => {
        syncAudioButtonsUI(false);
    });

    if (page2BgMusic) {
        const rawTime = parseFloat(localStorage.getItem("solarisMusicTime") || "0");
        const applySavedTime = () => {
            if (Number.isFinite(rawTime) && rawTime > 0) {
                const maxDur = Number.isFinite(page2BgMusic.duration) && page2BgMusic.duration > 0
                    ? page2BgMusic.duration - 0.1
                    : rawTime;
                try {
                    page2BgMusic.currentTime = Math.max(0, Math.min(rawTime, maxDur));
                } catch (_) {}
            }
        };
        if (page2BgMusic.readyState >= 1) applySavedTime();
        else page2BgMusic.addEventListener("loadedmetadata", applySavedTime, { once: true });

        page2BgMusic.addEventListener("play", () => {
            if (!page2BgMusic.muted) syncAudioButtonsUI(true);
            saveMusicState(true);
        });
        page2BgMusic.addEventListener("pause", () => {
            syncAudioButtonsUI(false);
            saveMusicState(false);
        });
        page2BgMusic.addEventListener("volumechange", () => saveMusicState());
        window.addEventListener("pagehide", () => saveMusicState());
        window.addEventListener("beforeunload", () => saveMusicState());
    }

    // ===================== SCENERY & PLANT VISUAL SYNC =====================
    function applySceneryMode(mode) {
        const chosen = ["daylight", "sunset", "night", "rain"].includes(mode) ? mode : "daylight";
        currentScenery = chosen;
        try { localStorage.setItem("configuredScenery", chosen); } catch (_) {}

        document.body.classList.remove(
            "mood-daylight", "mood-sunset", "mood-night", "mood-rain",
            "bg-scenery-daylight", "bg-scenery-sunset", "bg-scenery-night", "bg-scenery-rain"
        );
        document.body.classList.add(`mood-${chosen}`, `bg-scenery-${chosen}`);

        document.querySelectorAll(".scenery-opt-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.getAttribute("data-scenery") === chosen);
        });

        const isRain = chosen === "rain";
        document.querySelector("#indoorFxRain")?.classList.toggle("is-active", isRain);
        document.querySelector("#outdoorFxRain")?.classList.toggle("is-active", isRain);
        document.querySelector("#p2RainGroup")?.classList.toggle("is-active", isRain);

        applyTrackToPlayer(false);
    }

    function syncEnvironmentScene(envValue) {
        const chosenEnv = String(envValue).toLowerCase() === "outdoor" ? "Outdoor" : "Indoor";
        currentEnvironment = chosenEnv;
        try { localStorage.setItem("configuredEnvironment", chosenEnv); } catch (_) {}

        const isOutdoor = chosenEnv === "Outdoor";
        document.body.classList.toggle("env-outdoor", isOutdoor);
        document.body.classList.toggle("env-indoor", !isOutdoor);
        document.querySelector("#indoorScene")?.classList.toggle("is-active", !isOutdoor);
        document.querySelector("#outdoorScene")?.classList.toggle("is-active", isOutdoor);

        document.querySelectorAll(".environment-buttons button").forEach((btn) => {
            const match = btn.id === chosenEnv.toLowerCase();
            btn.classList.toggle("active", match);
            btn.setAttribute("aria-pressed", String(match));
        });

        applyTrackToPlayer(false);
    }

    function syncPlantSpeciesVisual(plantValue, animateGrow = true) {
        currentPlant = plantValue === "Oregano" ? "Oregano" : "Kalamansi";
        try { localStorage.setItem("configuredPlant", currentPlant); } catch (_) {}

        const isOregano = currentPlant.toLowerCase() === "oregano";
        const kalamansiGroup = document.querySelector("#speciesKalamansi");
        const oreganoGroup = document.querySelector("#speciesOregano");

        kalamansiGroup?.classList.toggle("is-active", !isOregano);
        oreganoGroup?.classList.toggle("is-active", isOregano);

        document.querySelector("#p2PlantKalamansi")?.classList.toggle("is-active", !isOregano);
        document.querySelector("#p2PlantOregano")?.classList.toggle("is-active", isOregano);

        if (animateGrow) {
            const activeGroup = isOregano ? oreganoGroup : kalamansiGroup;
            activeGroup?.querySelectorAll(".grow-stem, .grow-branch-1, .grow-branch-2, .grow-branch-3, .sprout-leaf")
                .forEach((el) => {
                    el.style.animation = "none";
                    void el.offsetWidth;
                    el.style.animation = "";
                });
        }
    }

    document.querySelectorAll(".scenery-opt-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            applySceneryMode(btn.getAttribute("data-scenery"));
        });
    });

    document.querySelectorAll(".environment-buttons button").forEach((button) => {
        button.addEventListener("click", () => {
            const envName = button.textContent.trim() || "Indoor";
            syncEnvironmentScene(envName);
        });
    });

    const plantSelect = document.querySelector("#plantType");
    plantSelect?.addEventListener("change", () => {
        syncPlantSpeciesVisual(plantSelect.value, true);
    });

    document.querySelector("#startMonitoring")?.addEventListener("click", async (e) => {
        e.preventDefault();
        unlockOrToggleAmbientAudio(true);
        const plantToSave = plantSelect ? plantSelect.value : currentPlant;
        const envToSave = currentEnvironment;
        syncPlantSpeciesVisual(plantToSave, false);
        syncEnvironmentScene(envToSave);

        try {
            await fetch(`${DB_URL}/irrigation.json`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    plantType: plantToSave,
                    environment: envToSave
                })
            });
        } catch (_) {}

        window.location.hash = "#monitoring";
        applyRouteView("monitoring");
    });

    document.querySelector("#backToConfigLink")?.addEventListener("click", (e) => {
        e.preventDefault();
        unlockOrToggleAmbientAudio(true);
        window.location.hash = "#configure";
        applyRouteView("config");
    });

    // ===================== MONITORING TELEMETRY & IRRIGATION LOGIC =====================
    function updateScrollRootsProgress() {
        if (!document.body.classList.contains("view-monitoring") && !isStandaloneMonitoring) return;
        const scrollTop = window.scrollY || window.pageYOffset || 0;
        const docHeight = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const progress = Math.min(1, Math.max(0, scrollTop / docHeight));
        document.documentElement.style.setProperty("--scroll-progress", progress.toFixed(4));
    }

    window.addEventListener("scroll", updateScrollRootsProgress, { passive: true });
    window.addEventListener("resize", updateScrollRootsProgress, { passive: true });

    function readNumber(data, ...keys) {
        for (const key of keys) {
            if (data && data[key] !== undefined && data[key] !== null) {
                const num = Number(data[key]);
                if (Number.isFinite(num)) return num;
            }
        }
        return null;
    }

    function setReading(id, value, fractionDigits = 1) {
        const element = document.querySelector(id);
        if (element) element.textContent = value === null ? "--" : value.toFixed(fractionDigits);
    }

    function setCardBadge(cardSelector, text) {
        const statEl = document.querySelector(`${cardSelector} .sensor-stats .stat`);
        if (statEl) statEl.textContent = text;
    }

    function setDeviceState(id, state) {
        const element = document.querySelector(id);
        if (!element) return;
        element.dataset.state = state;
        element.textContent = state === "on" ? "Online" : state === "off" ? "Offline" : "Unknown";
    }

    function formatTime(time) {
        if (!time || typeof time !== "string" || !time.includes(":")) return "Not scheduled";
        const [hours, minutes] = time.split(":").map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "Not scheduled";
        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function formatDateYYYYMMDDToDisplay(dateStr, timeStr) {
        if (!dateStr || !dateStr.includes("-")) return formatTime(timeStr);
        const [yyyy, mm, dd] = dateStr.split("-");
        const yy = yyyy.slice(-2);
        return `${mm}/${dd}/${yy} · ${formatTime(timeStr)}`;
    }

    function formatDurationHMS(totalSeconds) {
        const safe = Math.max(0, Math.floor(totalSeconds));
        const hrs = String(Math.floor(safe / 3600)).padStart(2, "0");
        const mins = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
        const secs = String(safe % 60).padStart(2, "0");
        return `${hrs}:${mins}:${secs}`;
    }

    function computeTargetDurationMsFromVolumeMl(volumeMl) {
        if (!Number.isFinite(volumeMl) || volumeMl <= 0) return 0;
        const msNeeded = Math.round((volumeMl / DRIPPER_ML_PER_SEC) * 1000);
        return Math.max(2000, msNeeded);
    }

    function estimateActiveSecondsFromLiters(liters) {
        const ml = liters * 1000;
        return Math.max(2, Math.round(computeTargetDurationMsFromVolumeMl(ml) / 1000));
    }

    function getPlantConfig() {
        return {
            plant: localStorage.getItem("configuredPlant") || currentPlant || "Kalamansi",
            environment: localStorage.getItem("configuredEnvironment") || currentEnvironment || "Indoor"
        };
    }

    function getRecordedPlantOptimal(plant, environment, soilPct = null) {
        const plantObj = PLANT_PROFILES[plant] || PLANT_PROFILES.Kalamansi;
        const base = plantObj[environment] || plantObj.Indoor;
        let liters = base.optimalLiters;

        if (typeof soilPct === "number" && Number.isFinite(soilPct)) {
            if (soilPct < 35) liters *= 1.15;
            else if (soilPct > 70) liters *= 0.75;
        }

        liters = Number(Math.min(2.0, Math.max(0.10, liters)).toFixed(2));
        const targetVolumeMl = Math.round(liters * 1000);
        const targetDurationMs = computeTargetDurationMsFromVolumeMl(targetVolumeMl);
        const estActiveSeconds = Math.max(2, Math.round(targetDurationMs / 1000));

        return {
            optimalTime: base.optimalTime,
            intervalHours: base.intervalHours,
            optimalLiters: liters,
            targetVolumeMl,
            targetDurationMs,
            estActiveSeconds
        };
    }

    function getNextOptimalDateYYYYMMDD(optimalTimeHHMM) {
        const now = new Date();
        const [h, m] = (optimalTimeHHMM || "06:00").split(":").map(Number);
        const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 6, m || 0, 0);
        if (candidate.getTime() <= now.getTime()) {
            candidate.setDate(candidate.getDate() + 1);
        }
        const yyyy = candidate.getFullYear();
        const mm = String(candidate.getMonth() + 1).padStart(2, "0");
        const dd = String(candidate.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    }

    function isScheduleExpired(irrigation) {
        if (!irrigation || !irrigation.optimalTime || !irrigation.optimalTime.includes(":")) {
            return false;
        }
        const dbStatus = String(irrigation.status || "").toUpperCase();
        if (dbStatus === "RUNNING") return false;

        const now = new Date();
        if (irrigation.optimalDate && irrigation.optimalDate.includes("-")) {
            const [y, mo, d] = irrigation.optimalDate.split("-").map(Number);
            const [h, mi] = irrigation.optimalTime.split(":").map(Number);
            const targetMs = new Date(y, mo - 1, d, h, mi, 0).getTime();
            return (now.getTime() - targetMs) >= 2 * 60000;
        }

        const [schedH, schedM] = irrigation.optimalTime.split(":").map(Number);
        const nowTotalMin = now.getHours() * 60 + now.getMinutes();
        const schedTotalMin = schedH * 60 + schedM;
        let diff = nowTotalMin - schedTotalMin;
        if (diff < -720) diff += 1440;
        return diff >= 2;
    }

    function isIrrigationBusy(irrigation) {
        const dbStatus = String((irrigation && irrigation.status) || "IDLE").toUpperCase();
        const mode = String((irrigation && irrigation.mode) || "SMART").toUpperCase();
        if (Boolean(irrigation && irrigation.manualPump) || mode === "MANUAL") return false;
        if (dbStatus === "RUNNING") return true;

        const armed = Boolean(irrigation && irrigation.armed);
        if ((armed || dbStatus === "SCHEDULED") && !isScheduleExpired(irrigation)) {
            return true;
        }
        return false;
    }

    function updateManualTimerUI() {
        const btn = document.querySelector("#manualIrrigateButton");
        const labelEl = document.querySelector("#manualButtonLabel");
        const pillEl = document.querySelector("#manualButtonTimer");
        const fullTimerEl = document.querySelector("#manualElapsedFull");
        const stateEl = document.querySelector("#manualPumpStateText");
        const indEl = document.querySelector("#manualModeIndication");
        const flowEl = document.querySelector("#manualLiveFlowText");

        if (flowEl) {
            flowEl.textContent = `${DRIPPER_L_PER_MIN.toFixed(3)} L/min · ${DRIPPER_ML_PER_MIN.toFixed(1)} mL/min`;
        }

        if (manualOpenStartedAtMs !== null) {
            const elapsedSec = (Date.now() - manualOpenStartedAtMs) / 1000;
            const formatted = formatDurationHMS(elapsedSec);
            const estMl = (elapsedSec * DRIPPER_ML_PER_SEC).toFixed(1);
            if (btn) btn.classList.add("is-open");
            if (labelEl) labelEl.textContent = "Close Pump";
            if (pillEl) pillEl.textContent = formatted;
            if (fullTimerEl) fullTimerEl.textContent = formatted;
            if (stateEl) stateEl.textContent = "OPEN (WATERING)";
            if (indEl) indEl.textContent = `Open for ${formatted} (~${estMl} mL) — tap again to close.`;
        } else {
            if (btn) btn.classList.remove("is-open");
            if (labelEl) labelEl.textContent = "Open Pump";
            if (pillEl) pillEl.textContent = "00:00:00";
            if (fullTimerEl) fullTimerEl.textContent = "00:00:00";
            if (stateEl) stateEl.textContent = "CLOSED";
            if (indEl) indEl.textContent = "Ready for instant on-the-spot pump control.";
        }
    }

    window.setInterval(updateManualTimerUI, 500);

    function setDisconnectedState() {
        setReading("#temperatureValue", null);
        setReading("#humidityValue", null);
        setReading("#waterFlowValue", DRIPPER_L_PER_MIN, 3);
        setReading("#waterLevelValue", null);
        setReading("#batteryVoltageValue", null);
        setReading("#solarVoltageValue", null);

        setCardBadge(".temperature-card", "Waiting for sensor");
        setCardBadge(".humidity-card", "Waiting for sensor");
        setCardBadge(".water-card:not(.rain-card)", "Waiting for sensor");

        const soilEl = document.querySelector("#soilMoistureReading");
        const soilStat = document.querySelector("#soilMoistureStatus");
        if (soilEl) soilEl.textContent = "No data";
        if (soilStat) soilStat.textContent = "Waiting for sensor";

        const rainEl = document.querySelector("#rainReading");
        const rainStat = document.querySelector("#rainStatus");
        if (rainEl) rainEl.textContent = "No data";
        if (rainStat) rainStat.textContent = "Waiting for sensor";

        setDeviceState("#solarStatus", "unknown");
        setDeviceState("#batteryStatus", "unknown");
        setDeviceState("#pumpStatus", "unknown");
    }

    async function updateDashboardFromFirebase() {
        const telemetryStatus = document.querySelector("#telemetryStatus");
        if (!telemetryStatus) return;
        const isSpaMonitoring = document.body.classList.contains("view-monitoring");
        if (!isSpaMonitoring && !isStandaloneMonitoring) return;

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const [sensorRes, irrigationRes] = await Promise.all([
                fetch(`${DB_URL}/sensors.json`, { cache: "no-store", signal: controller.signal }),
                fetch(`${DB_URL}/irrigation.json`, { cache: "no-store", signal: controller.signal })
            ]);

            if (!sensorRes.ok || !irrigationRes.ok) {
                throw new Error(`Firebase HTTP error: ${sensorRes.status} / ${irrigationRes.status}`);
            }

            const sensors = (await sensorRes.json()) || {};
            const irrigation = (await irrigationRes.json()) || {};

            const dbStatus = String(irrigation.status || "IDLE").toUpperCase();
            if ((irrigation.armed || dbStatus === "SCHEDULED") && isScheduleExpired(irrigation)) {
                const expKey = irrigation.triggerId || irrigation.optimalTime || "expired";
                if (lastClearedExpiredId !== expKey) {
                    lastClearedExpiredId = expKey;
                    fetch(`${DB_URL}/irrigation.json`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ armed: false, status: "EXPIRED" })
                    }).catch(() => {});
                }
                irrigation.armed = false;
                irrigation.status = "EXPIRED";
            }

            const tempVal = readNumber(sensors, "temperature", "temperatureC");
            const humVal = readNumber(sensors, "humidity", "humidityPercent");
            const waterLvlVal = readNumber(sensors, "waterLevelPct", "waterLevelPercent");
            const waterLvlCm = readNumber(sensors, "waterLevelCm");

            setReading("#temperatureValue", tempVal, 1);
            setReading("#humidityValue", humVal, 1);
            setReading("#waterFlowValue", DRIPPER_L_PER_MIN, 3);
            setReading("#waterLevelValue", waterLvlVal, 0);

            setCardBadge(
                ".temperature-card",
                tempVal !== null ? (tempVal >= 35 ? "Warm ambient" : "Live sensor") : "Waiting for sensor"
            );
            setCardBadge(".humidity-card", humVal !== null ? "Live sensor" : "Waiting for sensor");
            setCardBadge(
                ".water-card:not(.rain-card)",
                waterLvlVal !== null
                    ? (waterLvlCm !== null ? `Tank depth: ${waterLvlCm.toFixed(1)} cm` : "Live tank sensor")
                    : "Waiting for sensor"
            );

            const dripDetailEl = document.querySelector("#dripperRateDetail");
            if (dripDetailEl) {
                dripDetailEl.textContent = `~${DRIPPER_ML_PER_MIN.toFixed(1)} mL/min · ~${DRIPPER_ML_PER_SEC.toFixed(2)} mL/s (1 dripper)`;
            }

            const batV = readNumber(sensors, "batteryVoltage");
            const solV = readNumber(sensors, "solarVoltage");
            setReading("#batteryVoltageValue", batV, 2);
            setReading("#solarVoltageValue", solV, 2);

            const soilPct = readNumber(sensors, "soilMoisturePct");
            latestSoilMoisturePct = soilPct;
            const soilEl = document.querySelector("#soilMoistureReading");
            const soilStat = document.querySelector("#soilMoistureStatus");
            if (soilEl && soilStat) {
                if (soilPct !== null) {
                    soilEl.textContent = `${soilPct}%`;
                    soilStat.textContent = soilPct >= 40 ? "Moist / Optimal" : "Dry · Needs water";
                } else {
                    soilEl.textContent = "No data";
                    soilStat.textContent = "Waiting for sensor";
                }
            }

            const rainRawText = String(sensors.rainStatus || "").trim();
            const rainEl = document.querySelector("#rainReading");
            const rainStat = document.querySelector("#rainStatus");
            if (rainEl && rainStat) {
                if (rainRawText) {
                    const isRaining = rainRawText.toLowerCase() === "raining";
                    rainEl.textContent = isRaining ? "Raining" : "Dry";
                    rainStat.textContent = isRaining ? "Rain detected" : "No rain";
                } else {
                    rainEl.textContent = "No data";
                    rainStat.textContent = "Waiting for sensor";
                }
            }

            setDeviceState("#batteryStatus", batV !== null && batV > 9.0 ? "on" : "off");
            setDeviceState("#solarStatus", solV !== null && solV > 5.0 ? "on" : "off");
            const isPumpRunning =
                String(irrigation.status || "").toUpperCase() === "RUNNING" || Boolean(irrigation.manualPump);
            setDeviceState("#pumpStatus", isPumpRunning ? "on" : "off");

            if (irrigation.manualPump) {
                if (manualOpenStartedAtMs === null) {
                    const startNum = Number(irrigation.manualStartedAt);
                    const parsedStart = Number.isFinite(startNum) && startNum > 0
                        ? startNum
                        : (irrigation.manualStartedAt ? Date.parse(irrigation.manualStartedAt) : NaN);
                    manualOpenStartedAtMs = Number.isFinite(parsedStart) ? parsedStart : Date.now();
                }
            } else if (manualOpenStartedAtMs !== null) {
                manualOpenStartedAtMs = null;
            }
            updateManualTimerUI();

            renderIrrigationFromFirebase(irrigation);
            updateScrollRootsProgress();

            telemetryStatus.textContent = `Live data from Firebase · updated ${new Date().toLocaleTimeString()}`;
        } catch (_) {
            setDisconnectedState();
            telemetryStatus.textContent = "Cannot connect to Firebase. Check internet connection.";
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function renderIrrigationFromFirebase(irrigation) {
        const localCfg = getPlantConfig();
        const activePlant = irrigation.plantType || localCfg.plant;
        const activeEnv = irrigation.environment || localCfg.environment;
        syncPlantSpeciesVisual(activePlant, false);
        syncEnvironmentScene(activeEnv);

        const profile = getRecordedPlantOptimal(activePlant, activeEnv, latestSoilMoisturePct);

        const title = document.querySelector("#activePlantTitle");
        const configuredText = document.querySelector("#configuredPlantText");
        const historyName = document.querySelector("#historyPlantName");
        const statusEl = document.querySelector("#plantStatus");
        const nextSchedule = document.querySelector("#nextSchedule");
        const lowerOptimalLiters = document.querySelector("#lowerOptimalLiters");
        const scheduleSheet = document.querySelector("#scheduleSheet");
        const scheduledTime = document.querySelector("#scheduledTime");
        const scheduleStatus = document.querySelector("#scheduleStatus");
        const historyList = document.querySelector("#irrigationHistory");
        const irrigateBtn = document.querySelector("#smartIrrigateButton");
        const customSchedBtn = document.querySelector("#scheduledIrrigateButton");

        const smartTimeEl = document.querySelector("#smartOptimalTimeDisplay");
        const smartLitersEl = document.querySelector("#smartOptimalLitersDisplay");
        const smartIndEl = document.querySelector("#smartModeIndication");

        if (smartTimeEl) smartTimeEl.textContent = formatTime(profile.optimalTime);
        if (smartLitersEl) {
            smartLitersEl.textContent = `${profile.optimalLiters.toFixed(2)} L (${profile.targetVolumeMl} mL)`;
        }
        if (smartIndEl) {
            smartIndEl.textContent =
                `Optimal for ${activePlant} (${activeEnv}) · ~${profile.estActiveSeconds}s active pump time (pulsed 90s run / 120s rest).`;
        }

        if (title) title.textContent = `${activePlant} Dashboard`;
        if (configuredText) configuredText.textContent = `${activePlant} · ${activeEnv}`;
        if (historyName) historyName.textContent = `${activePlant} Status & History`;
        if (lowerOptimalLiters) {
            lowerOptimalLiters.textContent = `${profile.optimalLiters.toFixed(2)} L (${profile.targetVolumeMl} mL)`;
        }

        const dbStatus = String(irrigation.status || "IDLE").toUpperCase();
        const mode = String(irrigation.mode || "SMART").toUpperCase();
        const optTime = irrigation.optimalTime || profile.optimalTime;
        const busy = isIrrigationBusy(irrigation);

        if (irrigateBtn) {
            irrigateBtn.disabled = busy || Boolean(irrigation.manualPump);
            if (dbStatus === "RUNNING" && mode !== "MANUAL") {
                irrigateBtn.textContent = "Operating...";
            } else if (busy && mode !== "CUSTOM_SCHEDULE") {
                irrigateBtn.textContent = "Smart Scheduled";
            } else {
                irrigateBtn.textContent = "Smart Irrigate";
            }
        }

        if (customSchedBtn) {
            customSchedBtn.disabled = dbStatus === "RUNNING" || Boolean(irrigation.manualPump);
        }

        const customDtEl = document.querySelector("#customScheduleDateTimeDisplay");
        const customLitersEl = document.querySelector("#customScheduleLitersDisplay");
        const customBadgeEl = document.querySelector("#customScheduleStatusBadge");
        const customIndEl = document.querySelector("#customScheduleIndication");

        if (mode === "CUSTOM_SCHEDULE" && (busy || dbStatus === "COMPLETED")) {
            const customL = readNumber(irrigation, "targetLiters") ?? profile.optimalLiters;
            if (customDtEl) customDtEl.textContent = formatDateYYYYMMDDToDisplay(irrigation.optimalDate, irrigation.optimalTime);
            if (customLitersEl) customLitersEl.textContent = `${customL.toFixed(2)} L (${Math.round(customL * 1000)} mL)`;
            if (customBadgeEl) customBadgeEl.textContent = dbStatus;
            if (customIndEl) {
                customIndEl.textContent = busy
                    ? `Scheduled to deliver ${customL.toFixed(2)} L on ${irrigation.optimalDate} at ${formatTime(irrigation.optimalTime)}.`
                    : `Last custom schedule (${customL.toFixed(2)} L) completed.`;
            }
        } else {
            if (customDtEl) customDtEl.textContent = "Not set";
            if (customLitersEl) customLitersEl.textContent = `${profile.optimalLiters.toFixed(2)} L`;
            if (customBadgeEl) customBadgeEl.textContent = "READY";
            if (customIndEl) customIndEl.textContent = "Set MM / DD / HR / MIN / YY and water volume in Liters (L).";
        }

        if (statusEl) {
            if (irrigation.manualPump) statusEl.textContent = "Manual irrigation active (pump open)";
            else if (dbStatus === "RUNNING") statusEl.textContent = "Pump currently watering (pulsed mode)...";
            else if (busy) statusEl.textContent = `Irrigation scheduled (${mode === "CUSTOM_SCHEDULE" ? "Custom" : "Smart"})`;
            else if (dbStatus === "COMPLETED") statusEl.textContent = `Completed (${irrigation.lastWateredAt || "Recent"})`;
            else if (dbStatus === "SKIPPED_RAIN") statusEl.textContent = "Full stop: Raining during trigger (records active)";
            else if (dbStatus === "SKIPPED_MOIST") statusEl.textContent = "Skipped: Soil already moist for this plant";
            else if (dbStatus === "EXPIRED") statusEl.textContent = "Previous schedule expired · Ready";
            else statusEl.textContent = "Irrigation not scheduled";
        }

        if (nextSchedule) {
            nextSchedule.textContent = busy
                ? formatDateYYYYMMDDToDisplay(irrigation.optimalDate, optTime)
                : formatTime(profile.optimalTime);
        }

        if (scheduleSheet) {
            scheduleSheet.hidden = !busy;
            if (busy) {
                const activeLiters = readNumber(irrigation, "targetLiters") ?? profile.optimalLiters;
                if (scheduledTime) {
                    scheduledTime.textContent = `${formatDateYYYYMMDDToDisplay(irrigation.optimalDate, optTime)} (${activeLiters.toFixed(2)} L)`;
                }
                if (scheduleStatus) {
                    scheduleStatus.textContent = dbStatus === "RUNNING"
                        ? "Pump is active right now"
                        : "Automatic pump schedule active";
                }
            }
        }

        if (historyList) {
            historyList.replaceChildren();
            const historyObj = irrigation.history;
            if (!historyObj || typeof historyObj !== "object") {
                const item = document.createElement("li");
                item.textContent = "No watering sessions recorded.";
                historyList.appendChild(item);
            } else {
                const entries = Object.values(historyObj).reverse();
                entries.forEach((entry) => {
                    const item = document.createElement("li");
                    const stamp = entry.timestampText || "Unknown time";
                    const pName = entry.plantType || activePlant;
                    const envName = entry.environment || activeEnv;
                    const ml = readNumber(entry, "dispensedMl");
                    const volText = ml !== null ? ` · ${(ml / 1000).toFixed(2)} L (${ml.toFixed(0)} mL)` : "";
                    const noteText = entry.note ? ` [${entry.note}]` : "";
                    item.textContent = `${stamp} — ${pName} (${envName})${volText}${noteText}`;
                    historyList.appendChild(item);
                });
            }
        }
    }

    const irrigationDialog = document.querySelector("#irrigationDialog");
    const smartIrrigateButton = document.querySelector("#smartIrrigateButton");
    const cancelIrrigation = document.querySelector("#cancelIrrigation");
    const operateIrrigation = document.querySelector("#operateIrrigation");

    if (smartIrrigateButton && irrigationDialog) {
        smartIrrigateButton.addEventListener("click", () => {
            if (smartIrrigateButton.disabled) return;
            const { plant, environment } = getPlantConfig();
            const profile = getRecordedPlantOptimal(plant, environment, latestSoilMoisturePct);
            const targetDate = getNextOptimalDateYYYYMMDD(profile.optimalTime);

            const dialogPlantEl = document.querySelector("#dialogPlantName");
            const dialogScheduleEl = document.querySelector("#dialogScheduleText");

            if (dialogPlantEl) dialogPlantEl.textContent = `Smart Irrigate: ${plant} (${environment})`;
            if (dialogScheduleEl) {
                dialogScheduleEl.textContent =
                    `Scheduled at ${formatDateYYYYMMDDToDisplay(targetDate, profile.optimalTime)} for ${profile.optimalLiters.toFixed(2)} L (${profile.targetVolumeMl} mL, ~${profile.estActiveSeconds}s active run at ${DRIPPER_ML_PER_MIN.toFixed(1)} mL/min).`;
            }

            if (typeof irrigationDialog.showModal === "function") irrigationDialog.showModal();
            else irrigationDialog.setAttribute("open", "");
        });

        cancelIrrigation?.addEventListener("click", () => {
            if (typeof irrigationDialog.close === "function") irrigationDialog.close();
            else irrigationDialog.removeAttribute("open");
        });

        operateIrrigation?.addEventListener("click", async () => {
            const { plant, environment } = getPlantConfig();
            const profile = getRecordedPlantOptimal(plant, environment, latestSoilMoisturePct);
            const targetDate = getNextOptimalDateYYYYMMDD(profile.optimalTime);
            const triggerId = `SMART_${plant}_${targetDate}_${profile.optimalTime}_${Date.now()}`;

            operateIrrigation.disabled = true;
            operateIrrigation.textContent = "Scheduling...";

            try {
                const response = await fetch(`${DB_URL}/irrigation.json`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        armed: true,
                        manualPump: false,
                        status: "SCHEDULED",
                        mode: "SMART",
                        optimalDate: targetDate,
                        optimalTime: profile.optimalTime,
                        targetLiters: profile.optimalLiters,
                        targetVolumeMl: profile.targetVolumeMl,
                        targetDurationMs: profile.targetDurationMs,
                        triggerId: triggerId,
                        plantType: plant,
                        environment: environment
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await updateDashboardFromFirebase();
            } catch (error) {
                showNotice("Smart Irrigate Error", `Failed to send Smart Irrigate command: ${error.message}`);
            } finally {
                operateIrrigation.disabled = false;
                operateIrrigation.textContent = "Operate";
                if (typeof irrigationDialog.close === "function") irrigationDialog.close();
                else irrigationDialog.removeAttribute("open");
            }
        });
    }

    const manualIrrigateButton = document.querySelector("#manualIrrigateButton");
    if (manualIrrigateButton) {
        manualIrrigateButton.addEventListener("click", async () => {
            const { plant, environment } = getPlantConfig();
            const isCurrentlyOpen = manualOpenStartedAtMs !== null;
            const willOpen = !isCurrentlyOpen;

            manualIrrigateButton.disabled = true;
            try {
                const nowMs = Date.now();
                const payload = willOpen
                    ? {
                        armed: false,
                        manualPump: true,
                        status: "RUNNING",
                        mode: "MANUAL",
                        plantType: plant,
                        environment: environment,
                        manualStartedAt: nowMs
                    }
                    : {
                        armed: false,
                        manualPump: false,
                        status: "IDLE",
                        mode: "IDLE",
                        plantType: plant,
                        environment: environment,
                        manualStoppedAt: nowMs
                    };

                const res = await fetch(`${DB_URL}/irrigation.json`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                if (willOpen) {
                    manualOpenStartedAtMs = nowMs;
                } else {
                    const durationSec = manualOpenStartedAtMs
                        ? Math.max(1, Math.round((nowMs - manualOpenStartedAtMs) / 1000))
                        : 0;
                    const estMl = Number((durationSec * DRIPPER_ML_PER_SEC).toFixed(1));
                    manualOpenStartedAtMs = null;

                    if (durationSec > 0) {
                        const stamp = new Date().toLocaleString([], {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false
                        });
                        await fetch(`${DB_URL}/irrigation/history.json`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                plantType: plant,
                                environment: environment,
                                timestampText: `${stamp} (Manual ${formatDurationHMS(durationSec)})`,
                                dispensedMl: estMl,
                                mode: "MANUAL",
                                durationSeconds: durationSec
                            })
                        });
                    }
                }

                updateManualTimerUI();
                await updateDashboardFromFirebase();
            } catch (err) {
                showNotice("Manual Pump Error", `Failed to toggle manual pump: ${err.message}`);
            } finally {
                manualIrrigateButton.disabled = false;
            }
        });
    }

    const scheduledIrrigateButton = document.querySelector("#scheduledIrrigateButton");
    const customScheduleDialog = document.querySelector("#customScheduleDialog");
    const cancelCustomSchedule = document.querySelector("#cancelCustomSchedule");
    const customScheduleForm = document.querySelector("#customScheduleForm");

    function refreshCustomModalIndication() {
        const mm = String(document.querySelector("#schedMM")?.value || "").padStart(2, "0");
        const dd = String(document.querySelector("#schedDD")?.value || "").padStart(2, "0");
        const hr = String(document.querySelector("#schedHR")?.value || "").padStart(2, "0");
        const min = String(document.querySelector("#schedMIN")?.value || "").padStart(2, "0");
        const yy = String(document.querySelector("#schedYY")?.value || "").padStart(2, "0");
        const liters = parseFloat(document.querySelector("#schedLiters")?.value || "0");

        const { plant, environment } = getPlantConfig();
        const rec = getRecordedPlantOptimal(plant, environment, latestSoilMoisturePct);
        const indBox = document.querySelector("#customModalIndication");
        if (!indBox) return;

        const validLiters = Number.isFinite(liters) && liters > 0 ? liters : 0;
        const estActiveSec = estimateActiveSecondsFromLiters(validLiters);

        let msg = `Schedule: ${mm}/${dd}/20${yy} at ${hr}:${min} · ${validLiters.toFixed(2)} L (${Math.round(validLiters * 1000)} mL) · ~${estActiveSec}s active at ${DRIPPER_ML_PER_MIN.toFixed(1)} mL/min. `;
        if (validLiters > rec.optimalLiters * 1.4) {
            msg += `Warning: Above ${plant} optimal (${rec.optimalLiters.toFixed(2)} L).`;
        } else if (validLiters > 0 && validLiters < rec.optimalLiters * 0.5) {
            msg += `Note: Below ${plant} optimal (${rec.optimalLiters.toFixed(2)} L).`;
        } else {
            msg += `Matches ${plant} (${environment}) range.`;
        }
        indBox.textContent = msg;
    }

    if (scheduledIrrigateButton && customScheduleDialog) {
        scheduledIrrigateButton.addEventListener("click", () => {
            const now = new Date(Date.now() + 60000);
            const { plant, environment } = getPlantConfig();
            const rec = getRecordedPlantOptimal(plant, environment, latestSoilMoisturePct);

            const mmEl = document.querySelector("#schedMM");
            const ddEl = document.querySelector("#schedDD");
            const hrEl = document.querySelector("#schedHR");
            const minEl = document.querySelector("#schedMIN");
            const yyEl = document.querySelector("#schedYY");
            const litEl = document.querySelector("#schedLiters");

            if (mmEl) mmEl.value = String(now.getMonth() + 1).padStart(2, "0");
            if (ddEl) ddEl.value = String(now.getDate()).padStart(2, "0");
            if (hrEl) hrEl.value = String(now.getHours()).padStart(2, "0");
            if (minEl) minEl.value = String(now.getMinutes()).padStart(2, "0");
            if (yyEl) yyEl.value = String(now.getFullYear()).slice(-2);
            if (litEl) litEl.value = rec.optimalLiters.toFixed(2);

            const sub = document.querySelector("#customDialogSubtitle");
            if (sub) {
                sub.textContent = `${plant} (${environment}) — Optimal need: ${rec.optimalLiters.toFixed(2)} L at ${formatTime(rec.optimalTime)}.`;
            }

            refreshCustomModalIndication();
            if (typeof customScheduleDialog.showModal === "function") customScheduleDialog.showModal();
            else customScheduleDialog.setAttribute("open", "");
        });

        ["#schedMM", "#schedDD", "#schedHR", "#schedMIN", "#schedYY", "#schedLiters"].forEach((id) => {
            document.querySelector(id)?.addEventListener("input", refreshCustomModalIndication);
        });

        document.querySelectorAll(".liter-preset-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const val = Number(btn.getAttribute("data-liters"));
                const input = document.querySelector("#schedLiters");
                if (input && Number.isFinite(val)) {
                    input.value = val.toFixed(2);
                    refreshCustomModalIndication();
                }
            });
        });

        cancelCustomSchedule?.addEventListener("click", () => {
            if (typeof customScheduleDialog.close === "function") customScheduleDialog.close();
            else customScheduleDialog.removeAttribute("open");
        });

        customScheduleForm?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const mmNum = parseInt(document.querySelector("#schedMM")?.value ?? "", 10);
            const ddNum = parseInt(document.querySelector("#schedDD")?.value ?? "", 10);
            const hrNum = parseInt(document.querySelector("#schedHR")?.value ?? "", 10);
            const minNum = parseInt(document.querySelector("#schedMIN")?.value ?? "", 10);
            const yyNum = parseInt(document.querySelector("#schedYY")?.value ?? "", 10);
            const liters = parseFloat(document.querySelector("#schedLiters")?.value ?? "");

            if (
                mmNum < 1 || mmNum > 12 ||
                ddNum < 1 || ddNum > 31 ||
                hrNum < 0 || hrNum > 23 ||
                minNum < 0 || minNum > 59 ||
                yyNum < 0 || yyNum > 99 ||
                !Number.isFinite(liters) || liters <= 0
            ) {
                showNotice("Invalid Schedule", "Please enter valid MM, DD, HR, MIN, YY, and Water Volume (L).");
                return;
            }

            const mm = String(mmNum).padStart(2, "0");
            const dd = String(ddNum).padStart(2, "0");
            const hr = String(hrNum).padStart(2, "0");
            const min = String(minNum).padStart(2, "0");
            const yyyy = `20${String(yyNum).padStart(2, "0")}`;

            const optimalDate = `${yyyy}-${mm}-${dd}`;
            const optimalTime = `${hr}:${min}`;
            const targetVolumeMl = Math.round(liters * 1000);
            const targetDurationMs = computeTargetDurationMsFromVolumeMl(targetVolumeMl);
            const { plant, environment } = getPlantConfig();
            const triggerId = `CUSTOM_${optimalDate}_${optimalTime}_${Date.now()}`;

            const saveBtn = document.querySelector("#saveCustomSchedule");
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = "Saving...";
            }

            try {
                const response = await fetch(`${DB_URL}/irrigation.json`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        armed: true,
                        manualPump: false,
                        status: "SCHEDULED",
                        mode: "CUSTOM_SCHEDULE",
                        optimalDate,
                        optimalTime,
                        targetLiters: Number(liters.toFixed(2)),
                        targetVolumeMl,
                        targetDurationMs,
                        triggerId,
                        plantType: plant,
                        environment
                    })
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                if (typeof customScheduleDialog.close === "function") customScheduleDialog.close();
                else customScheduleDialog.removeAttribute("open");
                await updateDashboardFromFirebase();
            } catch (err) {
                showNotice("Schedule Error", `Failed to save schedule: ${err.message}`);
            } finally {
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = "Set Schedule";
                }
            }
        });
    }

    // ===================== INITIAL BOOT =====================
    if (plantSelect) {
        plantSelect.value = currentPlant;
    }
    syncPlantSpeciesVisual(currentPlant, false);
    syncEnvironmentScene(currentEnvironment);
    applySceneryMode(currentScenery);
    syncAudioButtonsUI(false);
    applyRouteView(getActiveRouteView());

    if (isStandaloneMonitoring) {
        updateDashboardFromFirebase();
    }

    window.setInterval(() => {
        if (document.body.classList.contains("view-monitoring") || isStandaloneMonitoring) {
            updateDashboardFromFirebase();
        }
    }, SENSOR_REFRESH_INTERVAL_MS);
})();