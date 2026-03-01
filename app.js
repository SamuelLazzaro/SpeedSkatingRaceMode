// © 2026 Samuel Lazzaro - Tutti i diritti riservati
// Licenza: CC BY-NC-ND 4.0 - https://creativecommons.org/licenses/by-nc-nd/4.0/

// ========== RACE TYPE CONSTANTS ==========
const RACE_TYPE_LABELS = {
    '100m': '100m',
    'crono': 'Giro cronometro',
    'sprint_giro': 'Giro sprint',
    '500m': '500m sprint',
    '1000m': '1000m',
    'punti': 'Gara a punti',
    'americana': 'Americana'
};
const TIMED_RACE_TYPES = ['100m', 'crono', 'sprint_giro', '500m', '1000m', 'americana'];
function isTimedRace(type) { return TIMED_RACE_TYPES.includes(type); }

// ========== STATE MANAGEMENT ==========
const state = {
    // Race type (null until admin selects)
    raceType: null,
    raceTitle: '',

    // For timed races
    timedBatteries: [],   // [{number, athletes:[{bib,name,surname,team,time,timeMs}], completed}]
    timedLeaderboard: [], // [{bib,name,surname,team,time,timeMs,position}]

    // For gara a punti with file (battery mode)
    garaPuntiBatteries: [],  // [{number, athletes:[{bib,name,surname,team}], raceState:null}]
    activeBatteryIndex: null, // null = manual / URL mode

    // ---- Gara a punti state ----
    config: {
        totalLaps: 0,
        pointsFrequency: 'every_lap'
    },
    raceStarted: false,
    raceEnded: false,
    lapsRemaining: 0,
    athletes: new Map(),
    currentCheckpoint: {
        number: 0,
        assignedAthletes: [],
        availablePoints: []
    },
    checkpointHistory: [],
    actionLog: []
};

// Athletes preloaded from starting list URL
let preloadedAthletes = [];

// Firebase sync state
let isAdmin = false;
let _firebaseListenerActive = false;

// Athlete data structure
class Athlete {
    constructor(number, name = '', surname = '') {
        this.number = number;
        this.name = name;
        this.surname = surname;
        this.points = 0;
        this.status = 'normal';
        this.savedPoints = 0;
    }
}

// ========== UTILITY FUNCTIONS ==========
function timestamp() {
    const now = new Date();
    return now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function logAction(message) {
    state.actionLog.push({ timestamp: timestamp(), message });
    console.log(`[${timestamp()}] ${message}`);
    saveToLocalStorage();
}

function saveToLocalStorage() {
    try {
        const athletesArr = Array.from(state.athletes.entries()).map(([k, v]) => [k, {
            number: v.number, name: v.name || '', surname: v.surname || '',
            points: v.points, status: v.status, savedPoints: v.savedPoints
        }]);

        const garaPuntiBatteriesSer = state.garaPuntiBatteries.map(b => ({
            number: b.number,
            athletes: b.athletes,
            raceState: b.raceState ? {
                raceStarted: b.raceState.raceStarted,
                raceEnded: b.raceState.raceEnded,
                lapsRemaining: b.raceState.lapsRemaining,
                athletes: b.raceState.athletes,
                currentCheckpoint: b.raceState.currentCheckpoint,
                checkpointHistory: b.raceState.checkpointHistory
            } : null
        }));

        const serialized = {
            raceType: state.raceType,
            raceTitle: state.raceTitle,
            timedBatteries: state.timedBatteries,
            timedLeaderboard: state.timedLeaderboard,
            garaPuntiBatteries: garaPuntiBatteriesSer,
            activeBatteryIndex: state.activeBatteryIndex,
            config: state.config,
            raceStarted: state.raceStarted,
            raceEnded: state.raceEnded,
            lapsRemaining: state.lapsRemaining,
            athletes: athletesArr,
            currentCheckpoint: state.currentCheckpoint,
            checkpointHistory: state.checkpointHistory,
            actionLog: state.actionLog
        };
        localStorage.setItem('raceState', JSON.stringify(serialized));
    } catch (error) {
        console.error('Errore nel salvataggio su localStorage:', error);
    }
    if (isAdmin) pushToFirebase();
}

function loadFromLocalStorage() {
    try {
        const saved = localStorage.getItem('raceState');
        if (saved) {
            const p = JSON.parse(saved);
            state.raceType = p.raceType || null;
            state.raceTitle = p.raceTitle || '';
            state.timedBatteries = p.timedBatteries || [];
            state.timedLeaderboard = p.timedLeaderboard || [];
            state.garaPuntiBatteries = p.garaPuntiBatteries || [];
            state.activeBatteryIndex = (p.activeBatteryIndex !== undefined) ? p.activeBatteryIndex : null;
            state.config = p.config || { totalLaps: 0, pointsFrequency: 'every_lap' };
            state.raceStarted = p.raceStarted || false;
            state.raceEnded = p.raceEnded || false;
            state.lapsRemaining = p.lapsRemaining || 0;
            state.athletes = new Map((p.athletes || []).map(([k, v]) => {
                const a = new Athlete(v.number, v.name || '', v.surname || '');
                a.points = v.points || 0;
                a.status = v.status || 'normal';
                a.savedPoints = v.savedPoints || 0;
                return [k, a];
            }));
            state.currentCheckpoint = p.currentCheckpoint || { number: 0, assignedAthletes: [], availablePoints: [] };
            state.checkpointHistory = p.checkpointHistory || [];
            state.actionLog = p.actionLog || [];
            return true;
        }
    } catch (error) {
        console.error('Errore nel caricamento da localStorage:', error);
    }
    return false;
}

function clearLocalStorage() {
    localStorage.removeItem('raceState');
}

// ========== SCREEN MANAGEMENT ==========
const ALL_SCREENS = ['raceTypeScreen', 'fileUploadScreen', 'configScreen', 'raceScreen', 'timedRaceScreen', 'garaPuntiBatteryScreen'];

function showOnlyScreen(screenId) {
    ALL_SCREENS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const target = document.getElementById(screenId);
    if (target) target.classList.remove('hidden');
}

// ========== RACE TYPE SELECTION ==========
function showRaceTypeSelector() {
    showOnlyScreen('raceTypeScreen');
    const badge = document.getElementById('adminBadgeRaceType');
    if (isAdmin) badge.classList.remove('hidden');
    else badge.classList.add('hidden');
}

document.querySelectorAll('.race-type-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!isAdmin) return;
        selectRaceType(btn.dataset.type);
    });
});

function selectRaceType(type) {
    state.raceType = type;
    if (type === 'punti') {
        showGaraPuntiSetup();
    } else {
        showFileUploadScreenForType(type);
    }
}

// ========== FILE UPLOAD SCREEN (timed races) ==========
let _parsedTimedFile = null; // {title, batteries}

function showFileUploadScreenForType(type) {
    _parsedTimedFile = null;
    const label = document.getElementById('fileUploadRaceTypeLabel');
    if (label) label.textContent = RACE_TYPE_LABELS[type] || type;
    const fileInput = document.getElementById('htmFileInput');
    if (fileInput) fileInput.value = '';
    const labelText = document.getElementById('fileInputLabelText');
    if (labelText) labelText.textContent = 'Scegli file .htm...';
    const urlInput = document.getElementById('htmFileUrl');
    if (urlInput) urlInput.value = '';
    const statusEl = document.getElementById('fileUploadStatus');
    if (statusEl) { statusEl.className = 'load-status hidden'; statusEl.textContent = ''; }
    const confirmBtn = document.getElementById('btnConfirmFile');
    if (confirmBtn) confirmBtn.disabled = true;

    const adminBadge = document.getElementById('adminBadgeFileUpload');
    if (adminBadge) adminBadge.classList.toggle('hidden', !isAdmin);

    showOnlyScreen('fileUploadScreen');
}

document.getElementById('htmFileInput').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const labelText = document.getElementById('fileInputLabelText');
    if (labelText) labelText.textContent = file.name;
    // Reset URL input since file is now the source
    document.getElementById('htmFileUrl').value = '';
    handleTimedFileLoad(file);
});

document.getElementById('btnLoadHtmUrl').addEventListener('click', async () => {
    const url = document.getElementById('htmFileUrl').value.trim();
    const statusEl = document.getElementById('fileUploadStatus');
    const confirmBtn = document.getElementById('btnConfirmFile');
    const btn = document.getElementById('btnLoadHtmUrl');

    if (!url) {
        statusEl.textContent = 'Inserisci un URL valido.';
        statusEl.className = 'load-status load-status-warning';
        return;
    }

    statusEl.textContent = 'Caricamento...';
    statusEl.className = 'load-status load-status-info';
    btn.disabled = true;
    confirmBtn.disabled = true;
    _parsedTimedFile = null;

    let html;
    try {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            html = await response.text();
        } catch (_) {
            const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
            const proxyResponse = await fetch(proxyUrl);
            if (!proxyResponse.ok) throw new Error(`HTTP ${proxyResponse.status}`);
            html = await proxyResponse.text();
        }

        const result = parseHtmFile(html);
        if (result.batteries.length === 0) {
            statusEl.textContent = 'Nessuna batteria trovata nel file.';
            statusEl.className = 'load-status load-status-warning';
            return;
        }
        const totalAthletes = result.batteries.reduce((sum, b) => sum + b.athletes.length, 0);
        statusEl.textContent = `✓ Caricate ${result.batteries.length} batterie con ${totalAthletes} atleti.`;
        if (result.title) statusEl.textContent += ` "${result.title}"`;
        statusEl.className = 'load-status load-status-success';
        _parsedTimedFile = result;
        // Reset file input since URL is now the source
        document.getElementById('htmFileInput').value = '';
        document.getElementById('fileInputLabelText').textContent = 'Scegli file .htm...';
        confirmBtn.disabled = false;
    } catch (err) {
        statusEl.textContent = 'Errore nel caricamento: ' + err.message;
        statusEl.className = 'load-status load-status-error';
    } finally {
        btn.disabled = false;
    }
});

function handleTimedFileLoad(file) {
    const statusEl = document.getElementById('fileUploadStatus');
    const confirmBtn = document.getElementById('btnConfirmFile');
    statusEl.className = 'load-status hidden';
    confirmBtn.disabled = true;
    _parsedTimedFile = null;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const result = parseHtmFile(e.target.result);
            if (result.batteries.length === 0) {
                statusEl.textContent = 'Nessuna batteria trovata nel file.';
                statusEl.className = 'load-status load-status-warning';
                return;
            }
            const totalAthletes = result.batteries.reduce((sum, b) => sum + b.athletes.length, 0);
            statusEl.textContent = `✓ Caricate ${result.batteries.length} batterie con ${totalAthletes} atleti.`;
            if (result.title) statusEl.textContent += ` "${result.title}"`;
            statusEl.className = 'load-status load-status-success';
            _parsedTimedFile = result;
            confirmBtn.disabled = false;
        } catch (err) {
            statusEl.textContent = 'Errore nella lettura del file: ' + err.message;
            statusEl.className = 'load-status load-status-error';
        }
    };
    reader.readAsText(file, 'UTF-8');
}

document.getElementById('btnConfirmFile').addEventListener('click', () => {
    if (!_parsedTimedFile) return;
    state.raceTitle = _parsedTimedFile.title || '';
    state.timedBatteries = _parsedTimedFile.batteries.map(b => ({
        number: b.number,
        athletes: b.athletes.map(a => ({ ...a, time: null, timeMs: null })),
        completed: false
    }));
    state.timedLeaderboard = [];
    saveToLocalStorage();
    showTimedRaceScreen();
});

document.getElementById('btnBackFromFile').addEventListener('click', () => {
    state.raceType = null;
    showRaceTypeSelector();
});

// ========== HTM FILE PARSER ==========
function parseHtmFile(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    const title = (doc.querySelector('title') || { textContent: '' }).textContent.trim();
    const batteries = [];

    doc.querySelectorAll('b').forEach(b => {
        const match = b.textContent.match(/Ordine di partenza batteria n\.(\d+)/i);
        if (!match) return;
        const batteryNumber = parseInt(match[1]);
        const table = b.nextElementSibling;
        if (!table || table.tagName !== 'TABLE') return;

        const athletes = [];
        table.querySelectorAll('tr').forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return;
            const bib = parseInt(cells[0].textContent.trim());
            if (isNaN(bib) || bib <= 0) return;
            const fullName = cells[2].textContent.trim();
            const nameParts = fullName.split(/\s+/).filter(p => p.length > 0);
            const name = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
            const surname = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || '');
            const team = cells[4].textContent.trim();
            athletes.push({ bib, name, surname, team });
        });

        if (athletes.length > 0) {
            batteries.push({ number: batteryNumber, athletes, completed: false });
        }
    });

    batteries.sort((a, b) => a.number - b.number);
    return { title, batteries };
}

// ========== TIME UTILITIES ==========
function timeToMs(str) {
    str = (str || '').trim();
    // MM:SS.mmm
    let m = str.match(/^(\d{1,2}):(\d{2})\.(\d{3})$/);
    if (m) {
        const sec = parseInt(m[2]);
        if (sec >= 60) return null;
        return parseInt(m[1]) * 60000 + sec * 1000 + parseInt(m[3]);
    }
    // SS.mmm (no minutes)
    m = str.match(/^(\d{1,3})\.(\d{3})$/);
    if (m) return parseInt(m[1]) * 1000 + parseInt(m[2]);
    return null;
}

function msToTime(ms) {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

// ========== TIMED RACE SCREEN ==========
function showTimedRaceScreen() {
    showOnlyScreen('timedRaceScreen');

    // Title
    const titleLabel = RACE_TYPE_LABELS[state.raceType] || 'Gara a tempo';
    document.getElementById('timedRaceTitle').textContent = titleLabel;
    const subtitle = document.getElementById('timedRaceSubtitle');
    if (subtitle) subtitle.textContent = state.raceTitle || '';

    // Admin controls
    document.getElementById('timedAdminBadge').classList.toggle('hidden', !isAdmin);
    document.getElementById('btnTimedAdminLogin').classList.toggle('hidden', isAdmin);
    document.getElementById('btnChangeRaceTimed').classList.toggle('hidden', !isAdmin);

    renderTimedLeaderboard();
    renderRemainingBatteries();
}

function renderTimedLeaderboard() {
    const container = document.getElementById('timedLeaderboardContent');
    if (!container) return;

    if (state.timedLeaderboard.length === 0) {
        container.innerHTML = `
            <div class="empty-leaderboard">
                <div class="empty-leaderboard-icon">🏆</div>
                <p>Nessun atleta in classifica</p>
                <p style="font-size:14px;margin-top:8px;">In attesa dei primi tempi...</p>
            </div>`;
        return;
    }

    let html = `<table class="leaderboard-table">
        <thead><tr>
            <th style="width:60px;">Pos.</th>
            <th style="width:70px;">N.</th>
            <th>Cognome</th>
            <th>Nome</th>
            <th>Squadra</th>
            <th style="width:120px;">Tempo</th>
        </tr></thead><tbody>`;

    state.timedLeaderboard.forEach(entry => {
        const posClass = entry.position === 1 ? 'position-1' :
                         entry.position === 2 ? 'position-2' :
                         entry.position === 3 ? 'position-3' : 'position-other';
        html += `<tr>
            <td><span class="position-badge ${posClass}">${entry.position}</span></td>
            <td><span class="athlete-number">#${entry.bib}</span></td>
            <td>${entry.surname || ''}</td>
            <td>${entry.name || ''}</td>
            <td class="timed-team-cell">${entry.team || ''}</td>
            <td><span class="timed-time-cell">${entry.time || ''}</span></td>
        </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function renderRemainingBatteries() {
    const container = document.getElementById('remainingBatteriesContent');
    if (!container) return;

    const remaining = state.timedBatteries.filter(b => !b.completed);

    if (remaining.length === 0) {
        container.innerHTML = `
            <div class="empty-leaderboard">
                <div class="empty-leaderboard-icon">✅</div>
                <p>Tutte le batterie sono state completate</p>
            </div>`;
        return;
    }

    let html = '';
    remaining.forEach(battery => {
        const clickable = isAdmin;
        const athleteNames = battery.athletes.map(a => `#${a.bib} ${a.surname} ${a.name}`.trim()).join(', ');
        html += `<div class="remaining-battery-item ${clickable ? 'clickable' : ''}" data-battery="${battery.number}">
            <div class="remaining-battery-header">
                <span class="remaining-battery-title">Batteria n.${battery.number}</span>
                ${clickable ? '<span class="remaining-battery-enter">Inserisci tempi →</span>' : ''}
            </div>
            <div class="remaining-battery-athletes">${athleteNames}</div>
        </div>`;
    });

    container.innerHTML = html;

    if (isAdmin) {
        container.querySelectorAll('.remaining-battery-item.clickable').forEach(item => {
            item.addEventListener('click', () => {
                const batteryNumber = parseInt(item.dataset.battery);
                const idx = state.timedBatteries.findIndex(b => b.number === batteryNumber);
                if (idx >= 0) openBatteryTimeModal(idx);
            });
        });
    }
}

// ========== TIME ENTRY MODAL ==========
let _currentTimedBatteryIdx = -1;

function openBatteryTimeModal(batteryIdx) {
    _currentTimedBatteryIdx = batteryIdx;
    const battery = state.timedBatteries[batteryIdx];
    if (!battery) return;

    document.getElementById('timeEntryTitle').textContent = `Batteria n.${battery.number}`;

    const athletesContainer = document.getElementById('timeEntryAthletes');
    let html = '';
    battery.athletes.forEach(a => {
        const fullName = [a.surname, a.name].filter(Boolean).join(' ');
        html += `<div class="time-input-row">
            <span class="time-input-bib">#${a.bib}</span>
            <span class="time-input-name">${fullName}</span>
            <input type="text" class="time-input" data-bib="${a.bib}"
                   placeholder="00:00.000" autocomplete="off" inputmode="decimal"
                   value="${a.time || ''}">
        </div>`;
    });
    athletesContainer.innerHTML = html;

    document.getElementById('timeEntryModal').classList.remove('hidden');
    const firstInput = athletesContainer.querySelector('.time-input');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
}

function closeBatteryTimeModal() {
    document.getElementById('timeEntryModal').classList.add('hidden');
    _currentTimedBatteryIdx = -1;
}

document.getElementById('btnCloseTimeEntry').addEventListener('click', closeBatteryTimeModal);
document.getElementById('btnCancelTimeEntry').addEventListener('click', closeBatteryTimeModal);

document.getElementById('btnConfirmTimeEntry').addEventListener('click', () => {
    submitBatteryTimes(_currentTimedBatteryIdx);
});

function submitBatteryTimes(batteryIdx) {
    if (batteryIdx < 0) return;
    const battery = state.timedBatteries[batteryIdx];
    if (!battery) return;

    const inputs = document.querySelectorAll('#timeEntryAthletes .time-input');
    let hasError = false;
    const results = [];

    inputs.forEach(input => {
        const bib = parseInt(input.dataset.bib);
        const val = input.value.trim();
        if (!val) {
            // Empty = skip (no time assigned yet)
            input.classList.remove('error');
            results.push({ bib, time: null, timeMs: null });
            return;
        }
        const ms = timeToMs(val);
        if (ms === null) {
            input.classList.add('error');
            hasError = true;
        } else {
            input.classList.remove('error');
            results.push({ bib, time: msToTime(ms), timeMs: ms });
        }
    });

    if (hasError) {
        alert('❌ Uno o più tempi non sono nel formato corretto (MM:SS.mmm o SS.mmm)');
        return;
    }

    // Apply results to battery athletes
    results.forEach(r => {
        const athlete = battery.athletes.find(a => a.bib === r.bib);
        if (athlete) {
            athlete.time = r.time;
            athlete.timeMs = r.timeMs;
        }
    });

    // Mark battery as completed if all athletes have a time
    const allDone = battery.athletes.every(a => a.time !== null);
    if (allDone) battery.completed = true;

    // Rebuild leaderboard
    calculateTimedLeaderboard();
    saveToLocalStorage();
    closeBatteryTimeModal();
    renderTimedLeaderboard();
    renderRemainingBatteries();
}

function calculateTimedLeaderboard() {
    const entries = [];
    state.timedBatteries.forEach(battery => {
        battery.athletes.forEach(a => {
            if (a.timeMs !== null) {
                entries.push({ bib: a.bib, name: a.name, surname: a.surname, team: a.team, time: a.time, timeMs: a.timeMs });
            }
        });
    });

    // Sort by time ascending
    entries.sort((a, b) => a.timeMs - b.timeMs);

    // Assign positions (ties share same position)
    let pos = 1;
    for (let i = 0; i < entries.length; i++) {
        if (i > 0 && entries[i].timeMs !== entries[i - 1].timeMs) {
            pos = i + 1;
        }
        entries[i].position = pos;
    }

    state.timedLeaderboard = entries;
}

// ========== GARA A PUNTI — SETUP ==========
function showGaraPuntiSetup() {
    // Reset file state
    state.garaPuntiBatteries = [];
    state.activeBatteryIndex = null;
    preloadedAthletes = [];

    // Reset config screen inputs
    totalLapsInput.value = '10';
    toggleButtons.forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.frequency === 'every_lap') btn.classList.add('active');
    });
    document.getElementById('startingListUrl').value = '';
    document.getElementById('loadAthletesStatus').className = 'load-status hidden';
    document.getElementById('loadAthletesStatus').textContent = '';

    // Reset file tab
    const configFileStatus = document.getElementById('configFileStatus');
    if (configFileStatus) { configFileStatus.className = 'load-status hidden'; configFileStatus.textContent = ''; }
    const configFileInput = document.getElementById('configFileInput');
    if (configFileInput) configFileInput.value = '';
    const configFileLabelText = document.getElementById('configFileInputLabelText');
    if (configFileLabelText) configFileLabelText.textContent = 'Scegli file .htm...';

    // Reset to URL tab
    switchLoadTab('url');

    // Show/hide "Cambia gara" button (visible to admin, only if we arrived from raceTypeScreen)
    const btnChange = document.getElementById('btnChangeRaceConfig');
    if (btnChange) btnChange.classList.toggle('hidden', !isAdmin);
    document.getElementById('adminBadgeConfig').classList.toggle('hidden', !isAdmin);

    showOnlyScreen('configScreen');
}

// Load tabs (URL / File) in configScreen
function switchLoadTab(tab) {
    const urlPanel = document.getElementById('urlPanel');
    const filePanel = document.getElementById('filePanel');
    const tabUrl = document.getElementById('tabUrl');
    const tabFile = document.getElementById('tabFile');
    if (tab === 'url') {
        urlPanel.classList.remove('hidden');
        filePanel.classList.add('hidden');
        tabUrl.classList.add('active');
        tabFile.classList.remove('active');
    } else {
        urlPanel.classList.add('hidden');
        filePanel.classList.remove('hidden');
        tabUrl.classList.remove('active');
        tabFile.classList.add('active');
    }
}

document.getElementById('tabUrl').addEventListener('click', () => switchLoadTab('url'));
document.getElementById('tabFile').addEventListener('click', () => switchLoadTab('file'));

// File input in configScreen (gara a punti)
document.getElementById('configFileInput').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const labelText = document.getElementById('configFileInputLabelText');
    if (labelText) labelText.textContent = file.name;
    handleConfigFileLoad(file);
});

function handleConfigFileLoad(file) {
    const statusEl = document.getElementById('configFileStatus');
    statusEl.className = 'load-status hidden';
    state.garaPuntiBatteries = [];

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const result = parseHtmFile(e.target.result);
            if (result.batteries.length === 0) {
                statusEl.textContent = 'Nessuna batteria trovata nel file.';
                statusEl.className = 'load-status load-status-warning';
                return;
            }
            state.raceTitle = result.title || '';
            state.garaPuntiBatteries = result.batteries.map(b => ({
                number: b.number,
                athletes: b.athletes,
                raceState: null
            }));
            const totalAthletes = result.batteries.reduce((sum, b) => sum + b.athletes.length, 0);
            statusEl.textContent = `✓ ${result.batteries.length} batterie caricate, ${totalAthletes} atleti totali.`;
            statusEl.className = 'load-status load-status-success';
        } catch (err) {
            statusEl.textContent = 'Errore nella lettura del file: ' + err.message;
            statusEl.className = 'load-status load-status-error';
        }
    };
    reader.readAsText(file, 'UTF-8');
}

// ========== GARA A PUNTI — BATTERY LIST SCREEN ==========
function showGaraPuntiBatteryScreen() {
    showOnlyScreen('garaPuntiBatteryScreen');
    const titleEl = document.getElementById('garaPuntiBatteryTitle');
    if (titleEl) titleEl.textContent = state.raceTitle || '';
    document.getElementById('adminBadgeGaraPunti').classList.toggle('hidden', !isAdmin);
    document.getElementById('btnChangeRaceGaraPunti').classList.toggle('hidden', !isAdmin);
    renderGaraPuntiBatteryList();
}

function renderGaraPuntiBatteryList() {
    const container = document.getElementById('garaPuntiBatteryList');
    if (!container) return;
    if (state.garaPuntiBatteries.length === 0) {
        container.innerHTML = '<div class="empty-leaderboard"><p>Nessuna batteria caricata.</p></div>';
        return;
    }

    let html = '';
    state.garaPuntiBatteries.forEach((b, idx) => {
        const athleteNames = b.athletes.map(a => `${a.surname} ${a.name}`.trim()).join(', ');
        let statusLabel = 'Non iniziata';
        let statusClass = 'battery-status-pending';
        if (b.raceState) {
            if (b.raceState.raceEnded) { statusLabel = 'Completata'; statusClass = 'battery-status-done'; }
            else if (b.raceState.raceStarted) { statusLabel = 'In corso'; statusClass = 'battery-status-active'; }
            else { statusLabel = 'Configurata'; statusClass = 'battery-status-pending'; }
        }
        html += `<div class="battery-list-item" data-idx="${idx}">
            <div class="battery-list-item-left">
                <span class="battery-list-item-title">Batteria n.${b.number} (${b.athletes.length} atleti)</span>
                <span class="battery-list-item-athletes">${athleteNames}</span>
            </div>
            <span class="battery-list-item-status ${statusClass}">${statusLabel}</span>
        </div>`;
    });

    container.innerHTML = html;
    container.querySelectorAll('.battery-list-item').forEach(item => {
        item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.idx);
            selectGaraPuntiBattery(idx);
        });
    });
}

function selectGaraPuntiBattery(idx) {
    loadBatteryStateIntoMain(idx);
    showRaceScreenForBattery();
}

function loadBatteryStateIntoMain(idx) {
    const battery = state.garaPuntiBatteries[idx];
    state.activeBatteryIndex = idx;

    if (battery.raceState) {
        state.raceStarted = battery.raceState.raceStarted || false;
        state.raceEnded = battery.raceState.raceEnded || false;
        state.lapsRemaining = battery.raceState.lapsRemaining || 0;
        state.currentCheckpoint = battery.raceState.currentCheckpoint
            ? {
                number: battery.raceState.currentCheckpoint.number || 0,
                assignedAthletes: toArray(battery.raceState.currentCheckpoint.assignedAthletes),
                availablePoints: toArray(battery.raceState.currentCheckpoint.availablePoints)
              }
            : { number: 0, assignedAthletes: [], availablePoints: [] };
        state.checkpointHistory = toArray(battery.raceState.checkpointHistory).map(cp => ({
            number: cp.number,
            lapsBeforeDecrement: cp.lapsBeforeDecrement,
            athletes: toArray(cp.athletes)
        }));
        state.athletes = new Map();
        if (battery.raceState.athletes) {
            Object.values(battery.raceState.athletes).forEach(v => {
                const a = new Athlete(v.number, v.name || '', v.surname || '');
                a.points = v.points || 0;
                a.status = v.status || 'normal';
                a.savedPoints = v.savedPoints || 0;
                state.athletes.set(v.number, a);
            });
        }
    } else {
        // Fresh start for this battery
        state.raceStarted = false;
        state.raceEnded = false;
        state.lapsRemaining = state.config.totalLaps;
        state.athletes = new Map();
        battery.athletes.forEach(a => {
            const athlete = new Athlete(a.bib, a.name || '', a.surname || '');
            state.athletes.set(a.bib, athlete);
        });
        state.currentCheckpoint = { number: 0, assignedAthletes: [], availablePoints: [] };
        state.checkpointHistory = [];
    }
}

function saveCurrentBatteryState() {
    if (state.activeBatteryIndex === null) return;
    const athletesPlain = {};
    state.athletes.forEach((v, k) => {
        athletesPlain[String(k)] = {
            number: v.number, name: v.name || '', surname: v.surname || '',
            points: v.points, status: v.status, savedPoints: v.savedPoints
        };
    });
    state.garaPuntiBatteries[state.activeBatteryIndex].raceState = {
        raceStarted: state.raceStarted,
        raceEnded: state.raceEnded,
        lapsRemaining: state.lapsRemaining,
        athletes: athletesPlain,
        currentCheckpoint: {
            number: state.currentCheckpoint.number,
            assignedAthletes: state.currentCheckpoint.assignedAthletes || [],
            availablePoints: state.currentCheckpoint.availablePoints || []
        },
        checkpointHistory: state.checkpointHistory.map(cp => ({
            number: cp.number,
            lapsBeforeDecrement: cp.lapsBeforeDecrement,
            athletes: cp.athletes || []
        }))
    };
}

function showRaceScreenForBattery() {
    showOnlyScreen('raceScreen');

    // Buttons visibility
    btnStartRace.classList.toggle('hidden', state.raceStarted);
    btnEndRace.classList.toggle('hidden', !(state.lapsRemaining === 0 && state.raceStarted && !state.raceEnded));
    btnOpenKeyboard.classList.toggle('hidden', !state.raceStarted || state.raceEnded);
    btnUndo.classList.add('hidden');
    btnResetRace.classList.toggle('hidden', !isAdmin);
    btnExportPDF.classList.toggle('hidden', !state.raceEnded);

    // "Torna alle batterie" and "Cambia gara" visible
    document.getElementById('btnBackToBatteries').classList.toggle('hidden', !isAdmin);
    document.getElementById('btnChangeRaceRace').classList.toggle('hidden', !isAdmin);

    // Admin badge
    document.getElementById('adminBadge').classList.toggle('hidden', !isAdmin);
    document.getElementById('btnAdminLogin').classList.toggle('hidden', isAdmin);

    updateRaceHeader();
    updateUndoButton();
    renderLeaderboard();
    updateLastCheckpointSummary();
}

// "Torna alle batterie" button
document.getElementById('btnBackToBatteries').addEventListener('click', () => {
    if (!isAdmin) return;
    saveCurrentBatteryState();
    saveToLocalStorage();
    showGaraPuntiBatteryScreen();
});

// ========== "CAMBIA GARA" BUTTONS ==========
function confirmChangeRace() {
    showDialog(
        '🔄',
        'Cambiare gara?',
        'Tutti i dati della gara corrente verranno cancellati. Questa azione non può essere annullata.',
        () => resetAllAndGoToTypeSelector()
    );
}

function resetAllAndGoToTypeSelector() {
    clearLocalStorage();
    if (isAdmin && typeof db !== 'undefined') {
        db.ref('race').remove().catch(err => console.error('Firebase remove error:', err));
    }

    // Reset all state
    state.raceType = null;
    state.raceTitle = '';
    state.timedBatteries = [];
    state.timedLeaderboard = [];
    state.garaPuntiBatteries = [];
    state.activeBatteryIndex = null;
    state.config.totalLaps = 0;
    state.config.pointsFrequency = 'every_lap';
    state.raceStarted = false;
    state.raceEnded = false;
    state.lapsRemaining = 0;
    state.athletes.clear();
    state.currentCheckpoint = { number: 0, assignedAthletes: [], availablePoints: [] };
    state.checkpointHistory = [];
    state.actionLog = [];
    preloadedAthletes = [];
    _parsedTimedFile = null;

    showRaceTypeSelector();
}

document.getElementById('btnChangeRaceConfig').addEventListener('click', () => { if (isAdmin) confirmChangeRace(); });
document.getElementById('btnChangeRaceRace').addEventListener('click', () => { if (isAdmin) confirmChangeRace(); });
document.getElementById('btnChangeRaceTimed').addEventListener('click', () => { if (isAdmin) confirmChangeRace(); });
document.getElementById('btnChangeRaceGaraPunti').addEventListener('click', () => { if (isAdmin) confirmChangeRace(); });

// ========== CONFIGURATION SCREEN ==========
const configScreen = document.getElementById('configScreen');
const raceScreen = document.getElementById('raceScreen');
const totalLapsInput = document.getElementById('totalLaps');
const toggleButtons = document.querySelectorAll('.toggle-btn');
const btnStartConfig = document.getElementById('btnStartConfig');

toggleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        toggleButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// ========== STARTING LIST FETCH (URL) ==========
function parseAthleteTable(table) {
    const athletes = [];
    for (const row of table.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;
        if (Array.from(cells).some(td => td.textContent.trim() === 'NP')) continue;
        let num = parseInt(cells[0].textContent.trim(), 10);
        if (isNaN(num) || num <= 0) num = parseInt(cells[1].textContent.trim(), 10);
        if (isNaN(num) || num <= 0) continue;
        const nameParts = cells[2].textContent.trim().split(/\s+/).filter(p => p.length > 0);
        const name = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
        const surname = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || '');
        athletes.push({ number: num, name, surname });
    }
    return athletes;
}

async function fetchStartingList(url) {
    let html;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        html = await response.text();
    } catch (_) {
        const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
        const proxyResponse = await fetch(proxyUrl);
        if (!proxyResponse.ok) throw new Error(`HTTP ${proxyResponse.status}`);
        html = await proxyResponse.text();
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const tables = doc.querySelectorAll('table');
    if (tables.length < 3) throw new Error('Formato non riconosciuto');
    const batteries = [];
    for (let i = 2; i < tables.length; i++) {
        const athletes = parseAthleteTable(tables[i]);
        if (athletes.length > 0) batteries.push(athletes);
    }
    return batteries;
}

function renderBatterySelector(batteries, statusEl) {
    preloadedAthletes = [];
    let html = '<div class="battery-selector-label">Scegli batteria:</div>';
    html += '<div class="battery-selector-buttons">';
    batteries.forEach((_, i) => {
        html += `<button type="button" class="battery-btn" data-index="${i}">${i + 1}</button>`;
    });
    html += '</div>';
    html += '<div class="battery-selector-count hidden" id="batterySelectorCount"></div>';
    statusEl.innerHTML = html;
    statusEl.className = 'load-status load-status-info';

    statusEl.querySelectorAll('.battery-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = parseInt(btn.dataset.index);
            preloadedAthletes = batteries[index];
            statusEl.querySelectorAll('.battery-btn').forEach(b => b.classList.remove('battery-btn-selected'));
            btn.classList.add('battery-btn-selected');
            const countEl = document.getElementById('batterySelectorCount');
            countEl.textContent = `✓ ${preloadedAthletes.length} atleti caricati.`;
            countEl.classList.remove('hidden');
        });
    });
}

document.getElementById('btnLoadAthletes').addEventListener('click', async () => {
    const url = document.getElementById('startingListUrl').value.trim();
    const statusEl = document.getElementById('loadAthletesStatus');
    const btn = document.getElementById('btnLoadAthletes');

    if (!url) {
        statusEl.textContent = 'Inserisci un URL valido.';
        statusEl.className = 'load-status load-status-error';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Caricamento...';
    statusEl.className = 'load-status hidden';
    preloadedAthletes = [];

    try {
        const batteries = await fetchStartingList(url);
        if (batteries.length === 0) {
            statusEl.textContent = 'Nessun atleta trovato nel file.';
            statusEl.className = 'load-status load-status-warning';
        } else if (batteries.length === 1) {
            preloadedAthletes = batteries[0];
            statusEl.textContent = `✓ ${preloadedAthletes.length} atleti caricati.`;
            statusEl.className = 'load-status load-status-success';
        } else {
            renderBatterySelector(batteries, statusEl);
        }
    } catch (_) {
        preloadedAthletes = [];
        statusEl.textContent = 'Impossibile caricare gli atleti: errore di rete o CORS.';
        statusEl.className = 'load-status load-status-error';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Carica';
    }
});

// Start configuration (gara a punti)
btnStartConfig.addEventListener('click', () => {
    if (!isAdmin) return;
    const laps = parseInt(totalLapsInput.value);
    if (!laps || laps < 1) {
        alert('❌ Inserisci un numero di giri valido (minimo 1)');
        return;
    }

    const activeToggle = document.querySelector('.toggle-btn.active');
    const frequency = activeToggle.dataset.frequency;

    state.config.totalLaps = laps;
    state.config.pointsFrequency = frequency;
    state.lapsRemaining = laps;

    // Battery mode (file loaded with batteries)
    if (state.garaPuntiBatteries.length > 0) {
        logAction(`Configurazione gara a punti: ${laps} giri, traguardo ${frequency === 'every_lap' ? 'ogni giro' : 'ogni 2 giri'}, ${state.garaPuntiBatteries.length} batterie`);
        saveToLocalStorage();
        showGaraPuntiBatteryScreen();
        return;
    }

    // Manual / URL mode
    for (const data of preloadedAthletes) {
        if (!state.athletes.has(data.number)) {
            state.athletes.set(data.number, new Athlete(data.number, data.name, data.surname));
        }
    }
    preloadedAthletes = [];

    logAction(`Configurazione: ${laps} giri, Traguardo ${frequency === 'every_lap' ? 'ogni giro' : 'ogni 2 giri'}`);

    // Show race screen
    showOnlyScreen('raceScreen');
    document.getElementById('btnAdminLogin').classList.add('hidden');
    document.getElementById('adminBadge').classList.remove('hidden');
    document.getElementById('btnBackToBatteries').classList.add('hidden');
    document.getElementById('btnChangeRaceRace').classList.toggle('hidden', !isAdmin);
    btnResetRace.classList.remove('hidden');

    updateRaceHeader();
    renderLeaderboard();
});

// ========== RACE SCREEN ==========
const btnStartRace = document.getElementById('btnStartRace');
const btnEndRace = document.getElementById('btnEndRace');
const btnOpenKeyboard = document.getElementById('btnOpenKeyboard');
const btnUndo = document.getElementById('btnUndo');
const btnResetRace = document.getElementById('btnResetRace');
const btnExportPDF = document.getElementById('btnExportPDF');
const badgeConfig = document.getElementById('badgeConfig');
const badgeLaps = document.getElementById('badgeLaps');
const leaderboardContent = document.getElementById('leaderboardContent');
const lastCheckpointSummary = document.getElementById('lastCheckpointSummary');

function updateRaceHeader() {
    const freqText = state.config.pointsFrequency === 'every_lap' ? 'Ogni giro' : 'Ogni 2 giri';
    badgeConfig.textContent = `${state.config.totalLaps} giri • ${freqText}`;
    badgeLaps.textContent = `Giri rimanenti: ${state.lapsRemaining}`;
}

function updateLastCheckpointSummary() {
    if (!state.raceStarted || state.raceEnded) {
        lastCheckpointSummary.classList.add('hidden');
        return;
    }

    let checkpointToShow = null;
    if (state.currentCheckpoint.assignedAthletes.length > 0) {
        checkpointToShow = { number: state.currentCheckpoint.number, athletes: state.currentCheckpoint.assignedAthletes };
    } else if (state.checkpointHistory.length > 0) {
        const lastHistory = state.checkpointHistory[state.checkpointHistory.length - 1];
        checkpointToShow = { number: lastHistory.number, athletes: lastHistory.athletes };
    }

    if (!checkpointToShow || checkpointToShow.athletes.length === 0) {
        lastCheckpointSummary.classList.add('hidden');
        return;
    }

    const sortedAthletes = [...checkpointToShow.athletes].sort((a, b) => b.points - a.points);
    let html = `<div class="last-checkpoint-summary-title">Ultimo traguardo ${checkpointToShow.number}:</div>`;
    html += `<ul class="last-checkpoint-summary-list">`;
    sortedAthletes.forEach(assignment => {
        const athlete = state.athletes.get(assignment.number);
        const nameDisplay = athlete && (athlete.name || athlete.surname)
            ? ` ${athlete.name || ''} ${athlete.surname || ''}`.trim() : '';
        const separator = nameDisplay ? ' ' : '';
        html += `<li class="last-checkpoint-summary-item">#${assignment.number}${separator}${nameDisplay}: ${assignment.points}pt</li>`;
    });
    html += `</ul>`;
    lastCheckpointSummary.innerHTML = html;
    lastCheckpointSummary.classList.remove('hidden');
}

function startRace() {
    if (!isAdmin) return;
    state.raceStarted = true;
    btnStartRace.classList.add('hidden');
    btnOpenKeyboard.classList.remove('hidden');
    logAction('Gara iniziata');
    saveToLocalStorage();
    initializeCheckpoint();
    renderLeaderboard();
}

function endRace() {
    if (!isAdmin) return;
    showDialog(
        '🏁',
        'Terminare la Gara?',
        'La classifica verrà congelata e non potrai più modificarla. Vuoi continuare?',
        () => {
            state.raceEnded = true;
            btnEndRace.classList.add('hidden');
            btnOpenKeyboard.classList.add('hidden');
            btnUndo.classList.add('hidden');
            logAction('Gara terminata - Classifica congelata');
            saveToLocalStorage();
            renderLeaderboard();
            btnExportPDF.classList.remove('hidden');

            // If in battery mode, save the state
            if (state.activeBatteryIndex !== null) {
                saveCurrentBatteryState();
                saveToLocalStorage();
            }
        }
    );
}

function resetRace() {
    if (!isAdmin) return;

    if (state.activeBatteryIndex !== null) {
        // Battery mode: clear this battery and go back to battery list
        showDialog('🔄', 'Riavviare questa batteria?',
            'Il progresso di questa batteria verrà cancellato.',
            () => {
                state.garaPuntiBatteries[state.activeBatteryIndex].raceState = null;
                state.raceStarted = false;
                state.raceEnded = false;
                state.lapsRemaining = state.config.totalLaps;
                state.athletes = new Map();
                const battery = state.garaPuntiBatteries[state.activeBatteryIndex];
                battery.athletes.forEach(a => {
                    state.athletes.set(a.bib, new Athlete(a.bib, a.name || '', a.surname || ''));
                });
                state.currentCheckpoint = { number: 0, assignedAthletes: [], availablePoints: [] };
                state.checkpointHistory = [];
                saveToLocalStorage();
                showGaraPuntiBatteryScreen();
            }
        );
        return;
    }

    // Manual mode: reset and go back to config
    showDialog(
        '🔄',
        'Riavviare la Gara?',
        'Tutti i dati della gara verranno cancellati e tornerai alla configurazione. Questa azione non può essere annullata.',
        () => {
            clearLocalStorage();
            if (isAdmin && typeof db !== 'undefined') {
                db.ref('race').remove().catch(err => console.error('Firebase remove error:', err));
            }

            state.raceStarted = false;
            state.raceEnded = false;
            state.lapsRemaining = 0;
            state.athletes.clear();
            state.currentCheckpoint = { number: 0, assignedAthletes: [], availablePoints: [] };
            state.checkpointHistory = [];
            state.actionLog = [];

            btnStartRace.classList.remove('hidden');
            btnEndRace.classList.add('hidden');
            btnOpenKeyboard.classList.add('hidden');
            btnUndo.classList.add('hidden');
            btnExportPDF.classList.add('hidden');
            lastCheckpointSummary.classList.add('hidden');
            lastCheckpointSummary.innerHTML = '';

            showGaraPuntiSetup();
        }
    );
}

btnStartRace.addEventListener('click', startRace);
btnEndRace.addEventListener('click', endRace);
btnResetRace.addEventListener('click', resetRace);
btnExportPDF.addEventListener('click', exportToPDF);

// ========== CHECKPOINT MANAGEMENT ==========
function initializeCheckpoint() {
    state.currentCheckpoint.number++;
    state.currentCheckpoint.assignedAthletes = [];
    const isFinal = isNextCheckpointFinal();
    state.currentCheckpoint.availablePoints = isFinal ? [3, 2, 1] : [2, 1];
    console.log(`Checkpoint ${state.currentCheckpoint.number} inizializzato, Finale: ${isFinal}`);
}

function isNextCheckpointFinal() {
    if (state.config.pointsFrequency === 'every_lap') return state.lapsRemaining === 1;
    return state.lapsRemaining === 2;
}

function canAssignPoints(points) {
    return state.currentCheckpoint.availablePoints.includes(points);
}

function isAthleteAlreadyAssignedInCheckpoint(athleteNumber) {
    return state.currentCheckpoint.assignedAthletes.some(a => a.number === athleteNumber);
}

function assignPointsToAthlete(athleteNumber, points, name = '', surname = '') {
    if (!isAdmin) return false;
    if (state.raceEnded) {
        alert('❌ La gara è terminata, non puoi più modificare la classifica');
        return false;
    }
    if (!canAssignPoints(points)) {
        alert(`❌ Non puoi assegnare ${points} punti in questo checkpoint`);
        return false;
    }
    if (isAthleteAlreadyAssignedInCheckpoint(athleteNumber)) {
        alert(`❌ L'atleta #${athleteNumber} ha già ricevuto punti in questo traguardo`);
        return false;
    }

    let athlete = state.athletes.get(athleteNumber);
    if (!athlete) {
        athlete = new Athlete(athleteNumber, name, surname);
        state.athletes.set(athleteNumber, athlete);
        const nameDisplay = name || surname ? ` (${name} ${surname})`.trim() : '';
        logAction(`Atleta #${athleteNumber}${nameDisplay} aggiunto alla classifica`);
    } else {
        if ((name && !athlete.name) || (surname && !athlete.surname)) {
            if (name && !athlete.name) athlete.name = name;
            if (surname && !athlete.surname) athlete.surname = surname;
        }
    }

    if (athlete.status === 'disqualified') {
        alert(`❌ L'atleta #${athleteNumber} è squalificato. Riabilitalo prima di assegnare punti.`);
        return false;
    }

    const isFirstAssignment = state.currentCheckpoint.assignedAthletes.length === 0;
    athlete.points += points;
    state.currentCheckpoint.assignedAthletes.push({ number: athleteNumber, points });
    const index = state.currentCheckpoint.availablePoints.indexOf(points);
    state.currentCheckpoint.availablePoints.splice(index, 1);

    logAction(`Assegnati ${points} punti a #${athleteNumber} (Checkpoint ${state.currentCheckpoint.number})`);

    if (isFirstAssignment) {
        state.checkpointHistory.push({
            number: state.currentCheckpoint.number,
            athletes: [...state.currentCheckpoint.assignedAthletes],
            lapsBeforeDecrement: state.lapsRemaining
        });
        updateUndoButton();
    } else {
        const lastHistory = state.checkpointHistory[state.checkpointHistory.length - 1];
        lastHistory.athletes = [...state.currentCheckpoint.assignedAthletes];
    }

    checkCheckpointCompletion();
    renderLeaderboard();
    updateKeyboardPoints();
    updateLastCheckpointSummary();
    return true;
}

function checkCheckpointCompletion() {
    if (state.currentCheckpoint.availablePoints.length === 0) {
        completeCheckpoint();
    }
}

function completeCheckpoint() {
    const decrement = state.config.pointsFrequency === 'every_lap' ? 1 : 2;
    state.lapsRemaining -= decrement;
    logAction(`Checkpoint ${state.currentCheckpoint.number} completato - Giri: ${state.lapsRemaining}`);

    if (state.lapsRemaining === 0) {
        btnEndRace.classList.remove('hidden');
    }

    saveToLocalStorage();
    closeKeyboard();
    closeAthleteMenu();

    if (state.lapsRemaining > 0) {
        initializeCheckpoint();
    }

    updateRaceHeader();
    updateUndoButton();
    updateLastCheckpointSummary();
    renderLeaderboard();
}

// ========== UNDO FUNCTIONALITY ==========
function canUndo() {
    return state.checkpointHistory.length > 0 && !state.raceEnded;
}

function undoLastCheckpoint() {
    if (!isAdmin || !canUndo()) return;

    const lastCheckpoint = state.checkpointHistory[state.checkpointHistory.length - 1];
    showDialog(
        '↩️',
        'Annullare Ultimo Traguardo?',
        `Checkpoint ${lastCheckpoint.number}: ${lastCheckpoint.athletes.map(a => `#${a.number} (${a.points}pt)`).join(', ')}`,
        () => {
            lastCheckpoint.athletes.forEach(assignment => {
                const athlete = state.athletes.get(assignment.number);
                if (athlete) {
                    athlete.points -= assignment.points;
                    logAction(`Rimossi ${assignment.points} punti da #${assignment.number} (Undo Checkpoint ${lastCheckpoint.number})`);
                }
            });
            state.lapsRemaining = lastCheckpoint.lapsBeforeDecrement;
            state.checkpointHistory.pop();
            state.currentCheckpoint.number = lastCheckpoint.number;
            state.currentCheckpoint.assignedAthletes = [];
            const isFinal = isNextCheckpointFinal();
            state.currentCheckpoint.availablePoints = isFinal ? [3, 2, 1] : [2, 1];
            if (state.lapsRemaining > 0) {
                btnEndRace.classList.add('hidden');
            }
            logAction(`Undo Checkpoint ${lastCheckpoint.number} completato`);
            saveToLocalStorage();
            updateRaceHeader();
            updateUndoButton();
            updateLastCheckpointSummary();
            renderLeaderboard();
        }
    );
}

function updateUndoButton() {
    if (canUndo() && isAdmin) {
        btnUndo.classList.remove('hidden');
    } else {
        btnUndo.classList.add('hidden');
    }
}

btnUndo.addEventListener('click', undoLastCheckpoint);

// ========== LEADERBOARD RENDERING ==========
function getFinalCheckpointPoints(athleteNumber) {
    let finalCheckpoint = null;
    for (let i = state.checkpointHistory.length - 1; i >= 0; i--) {
        const checkpoint = state.checkpointHistory[i];
        const had3Points = checkpoint.athletes.some(a => a.points === 3);
        if (had3Points) { finalCheckpoint = checkpoint; break; }
    }
    if (!finalCheckpoint) return null;
    const assignment = finalCheckpoint.athletes.find(a => a.number === athleteNumber);
    if (assignment) {
        const order = finalCheckpoint.athletes.findIndex(a => a.number === athleteNumber);
        return { points: assignment.points, order };
    }
    return { points: 0, order: 999 };
}

function renderLeaderboard() {
    if (state.athletes.size === 0) {
        const emptyMsg = isAdmin
            ? (state.raceStarted ? 'Assegna i primi punti per iniziare' : 'Premi "Start Gara" per iniziare')
            : 'La gara non è ancora iniziata...';
        leaderboardContent.innerHTML = `
            <div class="empty-leaderboard">
                <div class="empty-leaderboard-icon">🏆</div>
                <p>Nessun atleta in classifica</p>
                <p style="font-size: 14px; margin-top: 8px;">${emptyMsg}</p>
            </div>`;
        return;
    }

    const sortedAthletes = Array.from(state.athletes.values())
        .sort((a, b) => {
            if (a.status === 'disqualified' && b.status !== 'disqualified') return 1;
            if (a.status !== 'disqualified' && b.status === 'disqualified') return -1;
            if (a.status === 'lapped' && b.status !== 'lapped') return 1;
            if (a.status !== 'lapped' && b.status === 'lapped') return -1;
            if (b.points !== a.points) return b.points - a.points;
            if (a.status === 'normal' && a.points === 0) return a.number - b.number;
            const aFinal = getFinalCheckpointPoints(a.number);
            const bFinal = getFinalCheckpointPoints(b.number);
            if (aFinal && bFinal) {
                if (bFinal.points !== aFinal.points) return bFinal.points - aFinal.points;
                return aFinal.order - bFinal.order;
            }
            return 0;
        });

    let html = `
        <table class="leaderboard-table">
            <thead><tr>
                <th style="width: 60px;">Pos.</th>
                <th style="width: 80px;">Numero</th>
                <th>Cognome</th>
                <th>Nome</th>
                <th style="width: 80px;">Punti</th>
                <th style="width: 60px;">Stato</th>
            </tr></thead>
            <tbody>`;

    sortedAthletes.forEach((athlete, index) => {
        const position = index + 1;
        const positionClass = position === 1 ? 'position-1' : position === 2 ? 'position-2' : position === 3 ? 'position-3' : 'position-other';
        const statusIcon = athlete.status === 'lapped' ? '🔄' : athlete.status === 'disqualified' ? '❌' : '';
        const rowClass = `athlete-row-${athlete.status}`;
        const clickable = !state.raceEnded && isAdmin;

        html += `
            <tr class="${rowClass}" data-athlete="${athlete.number}" ${clickable ? 'style="cursor: pointer;"' : ''}>
                <td><span class="position-badge ${positionClass}">
                    <span class="pos-num">${position}</span>${statusIcon ? `<span class="pos-icon">${statusIcon}</span>` : ''}
                </span></td>
                <td><span class="athlete-number">#${athlete.number}</span></td>
                <td><span class="athlete-surname">${athlete.surname || ''}</span></td>
                <td><span class="athlete-name">${athlete.name || ''}</span></td>
                <td><span class="athlete-points">${athlete.points}</span></td>
                <td><span class="athlete-status">${statusIcon}</span></td>
            </tr>`;
    });

    html += '</tbody></table>';
    leaderboardContent.innerHTML = html;

    if (!state.raceEnded && isAdmin) {
        document.querySelectorAll('.leaderboard-table tbody tr').forEach(row => {
            row.addEventListener('click', (e) => {
                const athleteNumber = parseInt(row.dataset.athlete);
                showAthleteMenu(athleteNumber, e);
            });
        });
    }
}

// ========== ATHLETE MENU (Context Menu) ==========
const athleteMenu = document.getElementById('athleteMenu');
let currentMenuAthlete = null;

function showAthleteMenu(athleteNumber, event) {
    if (!isAdmin || state.raceEnded) return;
    currentMenuAthlete = athleteNumber;
    const athlete = state.athletes.get(athleteNumber);

    document.getElementById('athleteMenuNumber').textContent = `Atleta #${athleteNumber}`;

    const menuAssignPointsSection = document.getElementById('menuAssignPointsSection');
    const menuModifyPoints = document.getElementById('menuModifyPoints');
    const menuEditAthlete = document.getElementById('menuEditAthlete');
    const menuLap = document.getElementById('menuLap');
    const menuUnlap = document.getElementById('menuUnlap');
    const menuDisqualify = document.getElementById('menuDisqualify');
    const menuReinstate = document.getElementById('menuReinstate');
    const menuDivider2 = document.getElementById('menuDivider2');
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    editSubmenu.classList.add('hidden');

    [menuModifyPoints, menuEditAthlete, menuLap, menuUnlap, menuDisqualify, menuReinstate].forEach(item => {
        const newItem = item.cloneNode(true);
        item.parentNode.replaceChild(newItem, item);
    });

    const newMenuModifyPoints = document.getElementById('menuModifyPoints');
    const newMenuEditAthlete = document.getElementById('menuEditAthlete');
    const newMenuLap = document.getElementById('menuLap');
    const newMenuUnlap = document.getElementById('menuUnlap');
    const newMenuDisqualify = document.getElementById('menuDisqualify');
    const newMenuReinstate = document.getElementById('menuReinstate');

    menuAssignPointsSection.classList.add('hidden');
    newMenuModifyPoints.classList.add('hidden');
    newMenuEditAthlete.classList.add('hidden');
    newMenuLap.classList.add('hidden');
    newMenuUnlap.classList.add('hidden');
    newMenuDisqualify.classList.add('hidden');
    newMenuReinstate.classList.add('hidden');
    menuDivider2.classList.add('hidden');

    if (athlete.status === 'normal') {
        menuAssignPointsSection.classList.remove('hidden');
        newMenuModifyPoints.classList.remove('hidden');
        newMenuEditAthlete.classList.remove('hidden');
        newMenuLap.classList.remove('hidden');
        newMenuDisqualify.classList.remove('hidden');
        menuDivider2.classList.remove('hidden');
    } else if (athlete.status === 'lapped') {
        newMenuEditAthlete.classList.remove('hidden');
        newMenuUnlap.classList.remove('hidden');
        newMenuDisqualify.classList.remove('hidden');
    } else if (athlete.status === 'disqualified') {
        newMenuEditAthlete.classList.remove('hidden');
        newMenuReinstate.classList.remove('hidden');
    }

    updateAssignPointsButtons(athleteNumber);

    athleteMenu.querySelectorAll('.menu-item:not(.hidden)').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            handleMenuAction(item.dataset.action);
        });
    });

    const closeBtn = document.getElementById('menuCloseBtn');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    document.getElementById('menuCloseBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeAthleteMenu();
    });

    athleteMenu.classList.remove('hidden');
    positionMenu(event);
}

function positionMenu(event) {
    athleteMenu.style.left = '50%';
    athleteMenu.style.top = '50%';
    athleteMenu.style.transform = 'translate(-50%, -50%)';
    athleteMenu.style.maxHeight = `${Math.min(500, window.innerHeight - 40)}px`;
    athleteMenu.style.overflowY = 'auto';
}

function closeAthleteMenu() {
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) existingSubmenu.remove();
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    if (editSubmenu) editSubmenu.classList.add('hidden');
    athleteMenu.classList.add('hidden');
    currentMenuAthlete = null;
}

function updateAssignPointsButtons(athleteNumber) {
    const points = state.currentCheckpoint.availablePoints;
    const buttonsContainer = document.getElementById('menuAssignPointsButtons');
    const buttons = buttonsContainer.querySelectorAll('.submenu-btn');
    buttons.forEach(btn => {
        const pointValue = parseInt(btn.dataset.points);
        btn.disabled = !points.includes(pointValue);
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
    });
    buttonsContainer.querySelectorAll('.submenu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const pointValue = parseInt(btn.dataset.points);
            assignPointsToAthlete(athleteNumber, pointValue);
            closeAthleteMenu();
        });
    });
}

function handleMenuAction(action) {
    const athleteNumber = currentMenuAthlete;
    switch (action) {
        case 'modify-points': showModifyPointsSubmenu(athleteNumber); break;
        case 'edit-athlete': showEditAthleteSubmenu(athleteNumber); break;
        case 'lap': lapAthlete(athleteNumber); closeAthleteMenu(); break;
        case 'disqualify': disqualifyAthlete(athleteNumber); closeAthleteMenu(); break;
        case 'unlap': unlapAthlete(athleteNumber); closeAthleteMenu(); break;
        case 'reinstate': reinstateAthlete(athleteNumber); closeAthleteMenu(); break;
    }
}

function showModifyPointsSubmenu(athleteNumber) {
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) existingSubmenu.remove();
    document.getElementById('menuAssignPointsSection').classList.add('hidden');
    document.getElementById('menuEditAthleteSubmenu').classList.add('hidden');

    const submenu = document.createElement('div');
    submenu.className = 'submenu';
    const title = document.createElement('div');
    title.className = 'submenu-title';
    title.textContent = 'Modifica Punti (indipendente dai giri)';
    submenu.appendChild(title);

    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'submenu-buttons';
    ['+1', '+2', '+3', '-1', '-2', '-3'].forEach(modifyValue => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'submenu-btn';
        btn.dataset.modify = modifyValue;
        btn.textContent = modifyValue;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            modifyAthletePointsFree(athleteNumber, parseInt(modifyValue));
            closeAthleteMenu();
        });
        buttonsContainer.appendChild(btn);
    });
    submenu.appendChild(buttonsContainer);
    athleteMenu.insertBefore(submenu, document.getElementById('menuAssignPointsSection'));
}

function modifyAthletePointsFree(athleteNumber, pointsChange) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete) return;
    const newPoints = Math.max(0, athlete.points + pointsChange);
    athlete.points = newPoints;
    logAction(`Modifica libera: ${pointsChange > 0 ? '+' : ''}${pointsChange} punti a #${athleteNumber} (totale: ${newPoints})`);
    saveToLocalStorage();
    renderLeaderboard();
    updateLastCheckpointSummary();
}

function showEditAthleteSubmenu(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete) return;
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) existingSubmenu.remove();
    athleteMenu.querySelectorAll('.menu-item').forEach(item => item.classList.add('hidden'));
    athleteMenu.querySelectorAll('.menu-divider').forEach(divider => divider.classList.add('hidden'));
    document.getElementById('menuAssignPointsSection').classList.add('hidden');
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    editSubmenu.classList.remove('hidden');
    document.getElementById('editAthleteNumber').value = athlete.number;
    document.getElementById('editAthleteName').value = athlete.name || '';
    document.getElementById('editAthleteSurname').value = athlete.surname || '';

    const btnConfirm = document.getElementById('btnConfirmEditAthlete');
    const btnCancel = document.getElementById('btnCancelEditAthlete');
    const newBtnConfirm = btnConfirm.cloneNode(true);
    const newBtnCancel = btnCancel.cloneNode(true);
    btnConfirm.parentNode.replaceChild(newBtnConfirm, btnConfirm);
    btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);
    document.getElementById('btnConfirmEditAthlete').addEventListener('click', (e) => { e.stopPropagation(); editAthlete(athleteNumber); });
    document.getElementById('btnCancelEditAthlete').addEventListener('click', (e) => { e.stopPropagation(); closeAthleteMenu(); });
}

function editAthlete(originalAthleteNumber) {
    const athlete = state.athletes.get(originalAthleteNumber);
    if (!athlete) return;
    const newNumberInput = document.getElementById('editAthleteNumber').value.trim();
    const newName = document.getElementById('editAthleteName').value.trim();
    const newSurname = document.getElementById('editAthleteSurname').value.trim();

    if (!newNumberInput) { showDialog('⚠️', 'Errore', 'Il numero atleta è obbligatorio.', () => {}); document.getElementById('editAthleteNumber').value = athlete.number; return; }
    const newNumber = parseInt(newNumberInput);
    if (isNaN(newNumber) || newNumber <= 0) { showDialog('⚠️', 'Errore', 'Il numero atleta deve essere un valore positivo.', () => {}); document.getElementById('editAthleteNumber').value = athlete.number; return; }
    if (newNumber !== originalAthleteNumber && state.athletes.has(newNumber)) { showDialog('⚠️', 'Errore', `Il numero #${newNumber} è già assegnato ad un altro atleta.`, () => {}); document.getElementById('editAthleteNumber').value = athlete.number; return; }

    const oldDisplayName = athlete.name || athlete.surname ? ` (${athlete.name || ''} ${athlete.surname || ''})`.trim() : '';
    athlete.name = newName || null;
    athlete.surname = newSurname || null;
    const newDisplayName = athlete.name || athlete.surname ? ` (${athlete.name || ''} ${athlete.surname || ''})`.trim() : '';

    if (newNumber !== originalAthleteNumber) {
        athlete.number = newNumber;
        state.athletes.delete(originalAthleteNumber);
        state.athletes.set(newNumber, athlete);
        state.checkpointHistory.forEach(cp => {
            cp.athletes.forEach(a => { if (a.number === originalAthleteNumber) a.number = newNumber; });
        });
        state.currentCheckpoint.assignedAthletes.forEach(a => { if (a.number === originalAthleteNumber) a.number = newNumber; });
        logAction(`Atleta #${originalAthleteNumber}${oldDisplayName} modificato → #${newNumber}${newDisplayName}`);
        currentMenuAthlete = newNumber;
        document.getElementById('athleteMenuNumber').textContent = `Atleta #${newNumber}`;
    } else {
        if (oldDisplayName !== newDisplayName) logAction(`Atleta #${originalAthleteNumber}${oldDisplayName} modificato →${newDisplayName}`);
    }

    saveToLocalStorage();
    renderLeaderboard();
    updateLastCheckpointSummary();
    closeAthleteMenu();
}

function lapAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete) return;
    athlete.savedPoints = athlete.points;
    athlete.points = 0;
    athlete.status = 'lapped';
    logAction(`Atleta #${athleteNumber} doppiato (${athlete.savedPoints} punti conservati)`);
    saveToLocalStorage();
    renderLeaderboard();
}

function unlapAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete || athlete.status !== 'lapped') return;
    athlete.points = athlete.savedPoints;
    athlete.savedPoints = 0;
    athlete.status = 'normal';
    logAction(`Atleta #${athleteNumber} sdoppiato (${athlete.points} punti ripristinati)`);
    saveToLocalStorage();
    renderLeaderboard();
}

function disqualifyAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete) return;
    athlete.savedPoints = athlete.status === 'lapped' ? athlete.savedPoints : athlete.points;
    athlete.points = 0;
    athlete.status = 'disqualified';
    logAction(`Atleta #${athleteNumber} squalificato`);
    saveToLocalStorage();
    renderLeaderboard();
}

function reinstateAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete || athlete.status !== 'disqualified') return;
    athlete.points = athlete.savedPoints;
    athlete.savedPoints = 0;
    athlete.status = 'normal';
    logAction(`Atleta #${athleteNumber} riabilitato (${athlete.points} punti ripristinati)`);
    saveToLocalStorage();
    renderLeaderboard();
}

document.addEventListener('mousedown', (e) => {
    if (e.target.closest('#athleteMenu') || e.target.closest('.leaderboard-table tbody tr')) return;
    closeAthleteMenu();
});

// ========== KEYBOARD OVERLAY ==========
const keyboardOverlay = document.getElementById('keyboardOverlay');
const keyboardPointsGrid = document.getElementById('keyboardPointsGrid');
const btnCloseKeyboard = document.getElementById('btnCloseKeyboard');
const inputAthleteNumber = document.getElementById('inputAthleteNumber');
const inputAthleteName = document.getElementById('inputAthleteName');
const inputAthleteSurname = document.getElementById('inputAthleteSurname');

function openKeyboard() {
    if (!isAdmin) return;
    keyboardOverlay.classList.remove('hidden');
    clearKeyboardInputs();
    updateKeyboardPoints();
    updateKeyboardPointsButtons();
    setTimeout(() => inputAthleteNumber.focus(), 100);
}

function closeKeyboard() {
    keyboardOverlay.classList.add('hidden');
    clearKeyboardInputs();
}

function clearKeyboardInputs() {
    inputAthleteNumber.value = '';
    inputAthleteName.value = '';
    inputAthleteSurname.value = '';
    inputAthleteName.disabled = false;
    inputAthleteSurname.disabled = false;
}

function setKeyboardKeysEnabled(enabled) {
    document.querySelectorAll('.keyboard-key').forEach(key => { key.disabled = !enabled; });
}

inputAthleteName.addEventListener('focus', () => setKeyboardKeysEnabled(false));
inputAthleteSurname.addEventListener('focus', () => setKeyboardKeysEnabled(false));
inputAthleteName.addEventListener('blur', () => setKeyboardKeysEnabled(true));
inputAthleteSurname.addEventListener('blur', () => setKeyboardKeysEnabled(true));

function autoFillAthleteData() {
    const numberValue = inputAthleteNumber.value.trim();
    if (numberValue === '') {
        inputAthleteName.value = '';
        inputAthleteSurname.value = '';
        inputAthleteName.disabled = false;
        inputAthleteSurname.disabled = false;
        return;
    }
    const athleteNumber = parseInt(numberValue);
    const existingAthlete = state.athletes.get(athleteNumber);
    if (existingAthlete) {
        inputAthleteName.value = existingAthlete.name || '';
        inputAthleteSurname.value = existingAthlete.surname || '';
        inputAthleteName.disabled = true;
        inputAthleteSurname.disabled = true;
    } else {
        inputAthleteName.value = '';
        inputAthleteSurname.value = '';
        inputAthleteName.disabled = false;
        inputAthleteSurname.disabled = false;
    }
}

function updateKeyboardPoints() {
    const points = state.currentCheckpoint.availablePoints;
    const btnPoints3 = document.getElementById('btnPoints3');
    const btnPoints2 = document.getElementById('btnPoints2');
    const btnPoints1 = document.getElementById('btnPoints1');
    btnPoints3.disabled = !points.includes(3);
    btnPoints2.disabled = !points.includes(2);
    btnPoints1.disabled = !points.includes(1);

    keyboardPointsGrid.querySelectorAll('.keyboard-points-btn').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
    });
    keyboardPointsGrid.querySelectorAll('.keyboard-points-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const athleteNumber = inputAthleteNumber.value.trim();
            if (athleteNumber === '') { alert('❌ Inserisci il numero dell\'atleta'); inputAthleteNumber.focus(); return; }
            const athleteNumInt = parseInt(athleteNumber);
            const name = inputAthleteName.value.trim();
            const surname = inputAthleteSurname.value.trim();
            const points = parseInt(btn.dataset.points);
            if (assignPointsToAthlete(athleteNumInt, points, name, surname)) {
                clearKeyboardInputs();
                inputAthleteNumber.focus();
            }
        });
    });
}

btnOpenKeyboard.addEventListener('click', openKeyboard);
btnCloseKeyboard.addEventListener('click', closeKeyboard);

inputAthleteNumber.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
    updateKeyboardPointsButtons();
    const athleteNumber = parseInt(e.target.value);
    if (!isNaN(athleteNumber) && athleteNumber > 0) {
        const athlete = state.athletes.get(athleteNumber);
        if (athlete) {
            inputAthleteName.value = athlete.name || '';
            inputAthleteSurname.value = athlete.surname || '';
            inputAthleteName.disabled = true;
            inputAthleteSurname.disabled = true;
        } else {
            inputAthleteName.value = '';
            inputAthleteSurname.value = '';
            inputAthleteName.disabled = false;
            inputAthleteSurname.disabled = false;
        }
    } else {
        inputAthleteName.value = '';
        inputAthleteSurname.value = '';
        inputAthleteName.disabled = false;
        inputAthleteSurname.disabled = false;
    }
});

inputAthleteNumber.addEventListener('keypress', (e) => {
    if (!/[0-9]/.test(e.key) && e.key !== 'Enter' && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Tab') {
        e.preventDefault();
    }
});

function updateKeyboardPointsButtons() {
    const hasNumber = inputAthleteNumber.value.trim() !== '';
    const points = state.currentCheckpoint.availablePoints;
    document.getElementById('btnPoints3').disabled = !hasNumber || !points.includes(3);
    document.getElementById('btnPoints2').disabled = !hasNumber || !points.includes(2);
    document.getElementById('btnPoints1').disabled = !hasNumber || !points.includes(1);
}

document.querySelectorAll('.keyboard-key').forEach(key => {
    key.addEventListener('click', () => {
        const value = key.dataset.key;
        if (value === 'C') inputAthleteNumber.value = '';
        else if (value === 'backspace') inputAthleteNumber.value = inputAthleteNumber.value.slice(0, -1);
        else inputAthleteNumber.value += value;
        autoFillAthleteData();
        updateKeyboardPointsButtons();
        inputAthleteNumber.focus();
    });
});

// ========== DIALOG SYSTEM ==========
const dialogOverlay = document.getElementById('dialogOverlay');
const dialogIcon = document.getElementById('dialogIcon');
const dialogTitle = document.getElementById('dialogTitle');
const dialogMessage = document.getElementById('dialogMessage');
const dialogCancel = document.getElementById('dialogCancel');
const dialogConfirm = document.getElementById('dialogConfirm');
let dialogCallback = null;

function showDialog(icon, title, message, onConfirm) {
    dialogIcon.textContent = icon;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogCallback = onConfirm;
    dialogOverlay.classList.remove('hidden');
}

function closeDialog() {
    dialogOverlay.classList.add('hidden');
    dialogCallback = null;
}

dialogCancel.addEventListener('click', closeDialog);
dialogConfirm.addEventListener('click', () => {
    if (dialogCallback) dialogCallback();
    closeDialog();
});

// ========== FIREBASE SYNC ==========
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();
const auth = firebase.auth();
const raceRef = db.ref('race');

function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return Object.values(val);
}

function pushToFirebase() {
    const athletesObj = {};
    state.athletes.forEach((athlete, number) => {
        athletesObj[String(number)] = {
            number: athlete.number, name: athlete.name || '', surname: athlete.surname || '',
            points: athlete.points, status: athlete.status, savedPoints: athlete.savedPoints
        };
    });

    const garaPuntiBatteriesSer = state.garaPuntiBatteries.map(b => ({
        number: b.number,
        athletes: b.athletes,
        raceState: b.raceState || null
    }));

    raceRef.set({
        raceType: state.raceType,
        raceTitle: state.raceTitle || '',
        timedBatteries: state.timedBatteries,
        timedLeaderboard: state.timedLeaderboard,
        garaPuntiBatteries: garaPuntiBatteriesSer,
        activeBatteryIndex: state.activeBatteryIndex,
        config: state.config,
        raceStarted: state.raceStarted,
        raceEnded: state.raceEnded,
        lapsRemaining: state.lapsRemaining,
        athletes: athletesObj,
        currentCheckpoint: {
            number: state.currentCheckpoint.number,
            assignedAthletes: state.currentCheckpoint.assignedAthletes || [],
            availablePoints: state.currentCheckpoint.availablePoints || []
        },
        checkpointHistory: state.checkpointHistory.map(cp => ({
            number: cp.number,
            lapsBeforeDecrement: cp.lapsBeforeDecrement,
            athletes: cp.athletes || []
        }))
    }).catch(err => console.error('Firebase write error:', err));
}

function applyFirebaseState(data) {
    if (!data) return;

    state.raceType = data.raceType || null;
    state.raceTitle = data.raceTitle || '';
    state.timedBatteries = toArray(data.timedBatteries);
    state.timedLeaderboard = toArray(data.timedLeaderboard);
    state.garaPuntiBatteries = toArray(data.garaPuntiBatteries).map(b => ({
        number: b.number,
        athletes: toArray(b.athletes),
        raceState: b.raceState || null
    }));
    state.activeBatteryIndex = (data.activeBatteryIndex !== undefined && data.activeBatteryIndex !== null)
        ? data.activeBatteryIndex : null;
    state.config = data.config || { totalLaps: 0, pointsFrequency: 'every_lap' };
    state.raceStarted = data.raceStarted || false;
    state.raceEnded = data.raceEnded || false;
    state.lapsRemaining = data.lapsRemaining || 0;
    state.currentCheckpoint = {
        number: (data.currentCheckpoint && data.currentCheckpoint.number) || 0,
        assignedAthletes: toArray(data.currentCheckpoint && data.currentCheckpoint.assignedAthletes),
        availablePoints: toArray(data.currentCheckpoint && data.currentCheckpoint.availablePoints)
    };
    state.checkpointHistory = toArray(data.checkpointHistory).map(cp => ({
        number: cp.number,
        lapsBeforeDecrement: cp.lapsBeforeDecrement,
        athletes: toArray(cp.athletes)
    }));

    state.athletes = new Map();
    if (data.athletes) {
        Object.values(data.athletes).forEach(athleteData => {
            const a = new Athlete(athleteData.number, athleteData.name || '', athleteData.surname || '');
            a.points = athleteData.points || 0;
            a.status = athleteData.status || 'normal';
            a.savedPoints = athleteData.savedPoints || 0;
            state.athletes.set(athleteData.number, a);
        });
    }

    // Route to correct screen
    if (state.raceType && isTimedRace(state.raceType)) {
        showTimedRaceScreen();
    } else if (state.raceType === 'punti') {
        // Viewers see the active battery's raceScreen (or waiting if no race started)
        showOnlyScreen('raceScreen');
        document.getElementById('btnAdminLogin').classList.toggle('hidden', isAdmin);
        document.getElementById('adminBadge').classList.toggle('hidden', !isAdmin);
        document.getElementById('btnBackToBatteries').classList.add('hidden'); // viewers never see this
        document.getElementById('btnChangeRaceRace').classList.toggle('hidden', !isAdmin);
        updateRaceHeader();
        renderLeaderboard();
        updateLastCheckpointSummary();
        updateUndoButton();
        if (!isAdmin) {
            btnExportPDF.classList.toggle('hidden', !state.raceEnded);
        }
    } else {
        // No active race for viewers: show waiting in raceScreen
        showOnlyScreen('raceScreen');
        document.getElementById('btnAdminLogin').classList.toggle('hidden', isAdmin);
        document.getElementById('adminBadge').classList.toggle('hidden', !isAdmin);
        renderLeaderboard();
    }
}

// ========== VIEWER MODE ==========
function activateViewerMode() {
    isAdmin = false;

    document.getElementById('btnAdminLogin').classList.remove('hidden');
    document.getElementById('adminBadge').classList.add('hidden');
    document.getElementById('adminBadgeConfig').classList.add('hidden');

    btnStartRace.classList.add('hidden');
    btnEndRace.classList.add('hidden');
    btnOpenKeyboard.classList.add('hidden');
    btnUndo.classList.add('hidden');
    btnResetRace.classList.add('hidden');
    document.getElementById('btnBackToBatteries').classList.add('hidden');
    document.getElementById('btnChangeRaceRace').classList.add('hidden');

    showOnlyScreen('raceScreen');

    if (!_firebaseListenerActive) {
        _firebaseListenerActive = true;
        raceRef.on('value', (snapshot) => {
            if (isAdmin) return;
            const data = snapshot.val();
            if (data && data.raceType) {
                applyFirebaseState(data);
            } else if (data && data.raceStarted) {
                // Legacy gara a punti without raceType field
                applyFirebaseState({ ...data, raceType: 'punti' });
            } else {
                // No race: show waiting message
                showOnlyScreen('raceScreen');
                document.getElementById('btnAdminLogin').classList.remove('hidden');
                badgeConfig.textContent = '-';
                badgeLaps.textContent = 'Giri rimanenti: -';
                leaderboardContent.innerHTML = `
                    <div class="empty-leaderboard">
                        <div class="empty-leaderboard-icon">🏆</div>
                        <p>In attesa della prossima gara...</p>
                    </div>`;
            }
        });
    }
}

// ========== ADMIN MODE ==========
function activateAdminMode() {
    isAdmin = true;

    if (_firebaseListenerActive) {
        raceRef.off();
        _firebaseListenerActive = false;
    }

    document.getElementById('btnAdminLogin').classList.add('hidden');
    document.getElementById('adminBadge').classList.remove('hidden');
    document.getElementById('adminBadgeConfig').classList.remove('hidden');
    btnResetRace.classList.remove('hidden');

    const hasLocalState = loadFromLocalStorage();
    if (hasLocalState && state.raceType) {
        if (isTimedRace(state.raceType)) {
            showTimedRaceScreen();
        } else if (state.raceType === 'punti') {
            if (state.garaPuntiBatteries.length > 0 && state.activeBatteryIndex === null) {
                showGaraPuntiBatteryScreen();
            } else if (state.activeBatteryIndex !== null) {
                showRaceScreenForBattery();
            } else {
                // Manual mode with existing race
                showOnlyScreen('raceScreen');
                document.getElementById('adminBadge').classList.remove('hidden');
                document.getElementById('btnAdminLogin').classList.add('hidden');
                document.getElementById('btnBackToBatteries').classList.add('hidden');
                document.getElementById('btnChangeRaceRace').classList.remove('hidden');
                btnResetRace.classList.remove('hidden');
                if (state.raceStarted) { btnStartRace.classList.add('hidden'); btnOpenKeyboard.classList.remove('hidden'); }
                if (state.lapsRemaining === 0 && state.raceStarted && !state.raceEnded) btnEndRace.classList.remove('hidden');
                if (state.raceEnded) btnExportPDF.classList.remove('hidden');
                updateUndoButton();
                updateRaceHeader();
                renderLeaderboard();
                updateLastCheckpointSummary();
            }
        }
    } else if (hasLocalState && !state.raceType) {
        // Legacy save without raceType
        showGaraPuntiSetup();
    } else {
        // No state: check Firebase
        raceRef.once('value').then(snapshot => {
            const data = snapshot.val();
            if (data && (data.raceType || data.raceStarted)) {
                const raceType = data.raceType || 'punti';
                applyFirebaseState({ ...data, raceType });
                saveToLocalStorage();
                // Re-show admin controls
                if (isTimedRace(raceType)) {
                    document.getElementById('timedAdminBadge').classList.remove('hidden');
                    document.getElementById('btnTimedAdminLogin').classList.add('hidden');
                    document.getElementById('btnChangeRaceTimed').classList.remove('hidden');
                } else {
                    document.getElementById('adminBadge').classList.remove('hidden');
                    document.getElementById('btnAdminLogin').classList.add('hidden');
                    document.getElementById('btnChangeRaceRace').classList.remove('hidden');
                    if (state.raceStarted) { btnStartRace.classList.add('hidden'); btnOpenKeyboard.classList.remove('hidden'); }
                    if (state.lapsRemaining === 0 && state.raceStarted && !state.raceEnded) btnEndRace.classList.remove('hidden');
                    updateUndoButton();
                }
                btnResetRace.classList.remove('hidden');
            } else {
                // No race anywhere: show race type selector
                showRaceTypeSelector();
            }
        });
    }
}

// ========== AUTH STATE LISTENER ==========
auth.onAuthStateChanged((user) => {
    document.getElementById('loadingOverlay').classList.add('hidden');
    if (user) {
        activateAdminMode();
    } else {
        activateViewerMode();
    }
});

// ========== LOGIN / LOGOUT ==========
document.getElementById('btnAdminLogin').addEventListener('click', () => {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').classList.add('hidden');
    setTimeout(() => document.getElementById('loginEmail').focus(), 100);
});

document.getElementById('loginCancelBtn').addEventListener('click', () => {
    document.getElementById('loginOverlay').classList.add('hidden');
});

document.getElementById('loginBtn').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    const loginBtn = document.getElementById('loginBtn');

    errorEl.classList.add('hidden');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Accesso...';

    try {
        await auth.signInWithEmailAndPassword(email, password);
        document.getElementById('loginOverlay').classList.add('hidden');
    } catch (_) {
        errorEl.classList.remove('hidden');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Accedi';
    }
});

document.getElementById('loginPassword').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

// Logout buttons (all screens)
function doLogout() { auth.signOut(); }
document.getElementById('btnLogout').addEventListener('click', doLogout);
document.getElementById('btnLogoutConfig').addEventListener('click', doLogout);
document.getElementById('btnLogoutRaceType').addEventListener('click', doLogout);
document.getElementById('btnLogoutFileUpload').addEventListener('click', doLogout);
document.getElementById('btnTimedLogout').addEventListener('click', doLogout);
document.getElementById('btnLogoutGaraPunti').addEventListener('click', doLogout);

// Admin login button on timed race screen (for viewers)
document.getElementById('btnTimedAdminLogin').addEventListener('click', () => {
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').classList.add('hidden');
    setTimeout(() => document.getElementById('loginEmail').focus(), 100);
});

// ========== PDF EXPORT ==========
function exportToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(20);
    doc.text('Speed Skating Points Race', 105, 20, { align: 'center' });

    doc.setFontSize(12);
    const checkpointText = state.config.pointsFrequency === 'every_lap' ? 'Ogni giro' : 'Ogni 2 giri';
    doc.text('Configurazione: ' + state.config.totalLaps + ' giri totali, Traguardi: ' + checkpointText, 105, 30, { align: 'center' });

    const now = new Date();
    const dateStr = now.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    doc.setFontSize(10);
    doc.text(`Esportato il ${dateStr} alle ${timeStr}`, 105, 37, { align: 'center' });

    doc.setFontSize(14);
    doc.text('Classifica Finale', 20, 50);

    const sortedAthletes = Array.from(state.athletes.values()).sort((a, b) => {
        if (a.status === 'disqualified' && b.status !== 'disqualified') return 1;
        if (a.status !== 'disqualified' && b.status === 'disqualified') return -1;
        if (a.status === 'lapped' && b.status !== 'lapped') return 1;
        if (a.status !== 'lapped' && b.status === 'lapped') return -1;
        if (b.points !== a.points) return b.points - a.points;
        const aFinal = getFinalCheckpointPoints(a.number);
        const bFinal = getFinalCheckpointPoints(b.number);
        if (aFinal && bFinal) {
            if (bFinal.points !== aFinal.points) return bFinal.points - aFinal.points;
            return aFinal.order - bFinal.order;
        }
        return 0;
    });

    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    let yPos = 60;
    doc.text('Pos', 20, yPos); doc.text('Num', 35, yPos); doc.text('Nome', 55, yPos);
    doc.text('Cognome', 95, yPos); doc.text('Punti', 140, yPos); doc.text('Stato', 165, yPos);
    doc.line(20, yPos + 2, 190, yPos + 2);

    doc.setFont(undefined, 'normal');
    yPos += 10;

    sortedAthletes.forEach((athlete, index) => {
        if (yPos > 270) { doc.addPage(); yPos = 20; }
        const position = athlete.status === 'disqualified' ? 'SQ' : athlete.status === 'lapped' ? 'D' : (index + 1).toString();
        const statusText = athlete.status === 'disqualified' ? 'Squalificato' : athlete.status === 'lapped' ? 'Doppiato' : '';
        doc.text(position, 20, yPos);
        doc.text(`#${athlete.number}`, 35, yPos);
        doc.text(athlete.name || '', 55, yPos);
        doc.text(athlete.surname || '', 95, yPos);
        doc.text(athlete.points.toString(), 140, yPos);
        if (statusText) doc.text(statusText, 165, yPos);
        yPos += 7;
    });

    yPos += 10;
    if (yPos > 250) { doc.addPage(); yPos = 20; }
    doc.setFontSize(14); doc.setFont(undefined, 'bold');
    doc.text('Riepilogo Traguardi', 20, yPos);
    yPos += 10;
    doc.setFontSize(10); doc.setFont(undefined, 'normal');

    if (state.checkpointHistory && state.checkpointHistory.length > 0) {
        const sortedCheckpoints = [...state.checkpointHistory].sort((a, b) => b.number - a.number);
        sortedCheckpoints.forEach(checkpoint => {
            const parts = [];
            if (checkpoint.athletes && checkpoint.athletes.length > 0) {
                const sortedAth = [...checkpoint.athletes].sort((a, b) => b.points - a.points);
                sortedAth.forEach(assignment => {
                    const athlete = state.athletes.get(assignment.number);
                    const nameDisplay = athlete && (athlete.name || athlete.surname) ? ` ${athlete.name || ''} ${athlete.surname || ''}`.trim() : '';
                    const separator = nameDisplay ? ' ' : '';
                    parts.push(`#${assignment.number}${separator}${nameDisplay} (${assignment.points}pt)`);
                });
            }
            if (parts.length > 0) {
                if (yPos > 275) { doc.addPage(); yPos = 20; }
                const line = `Traguardo ${checkpoint.number}: ${parts.join('; ')}`;
                const splitText = doc.splitTextToSize(line, 170);
                splitText.forEach(textLine => {
                    if (yPos > 275) { doc.addPage(); yPos = 20; }
                    doc.text(textLine, 20, yPos);
                    yPos += 6;
                });
            }
        });
    } else {
        doc.text('Nessun traguardo completato', 20, yPos);
    }

    doc.setFontSize(8);
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.text(`Pagina ${i} di ${pageCount}`, 105, 287, { align: 'center' });
        doc.text('Generato da Speed Skating Race', 105, 292, { align: 'center' });
    }

    doc.save(`gara_punti_${dateStr.replace(/\//g, '-')}_${timeStr.replace(/:/g, '-')}.pdf`);
}
