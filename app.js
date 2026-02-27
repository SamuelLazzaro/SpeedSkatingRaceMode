// ========== STATE MANAGEMENT ==========
const state = {
    // Configuration
    config: {
        totalLaps: 0,
        pointsFrequency: 'every_lap' // 'every_lap' or 'every_2_laps'
    },
    
    // Race state
    raceStarted: false,
    raceEnded: false,
    lapsRemaining: 0,
    
    // Athletes: Map<athleteNumber, athleteData>
    athletes: new Map(),
    
    // Current checkpoint tracking
    currentCheckpoint: {
        number: 0,
        assignedAthletes: [], // [{number, points}, ...]
        availablePoints: [] // [3, 2, 1] or [2, 1]
    },
    
    // Checkpoint history for undo
    checkpointHistory: [],
    
    // Action log
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
        this.status = 'normal'; // 'normal', 'lapped', 'disqualified'
        this.savedPoints = 0; // For lapped/disqualified recovery
    }
}

// ========== UTILITY FUNCTIONS ==========
function timestamp() {
    const now = new Date();
    return now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function logAction(message) {
    state.actionLog.push({
        timestamp: timestamp(),
        message: message
    });
    console.log(`[${timestamp()}] ${message}`);
    saveToLocalStorage();
}

function saveToLocalStorage() {
    try {
        const serializedState = {
            config: state.config,
            raceStarted: state.raceStarted,
            raceEnded: state.raceEnded,
            lapsRemaining: state.lapsRemaining,
            athletes: Array.from(state.athletes.entries()),
            currentCheckpoint: state.currentCheckpoint,
            checkpointHistory: state.checkpointHistory,
            actionLog: state.actionLog
        };
        localStorage.setItem('raceState', JSON.stringify(serializedState));
    } catch (error) {
        console.error('Errore nel salvataggio su localStorage:', error);
    }
    // Sync to Firebase when admin
    if (isAdmin) pushToFirebase();
}

function loadFromLocalStorage() {
    try {
        const saved = localStorage.getItem('raceState');
        if (saved) {
            const parsed = JSON.parse(saved);
            state.config = parsed.config;
            state.raceStarted = parsed.raceStarted;
            state.raceEnded = parsed.raceEnded;
            state.lapsRemaining = parsed.lapsRemaining;
            state.athletes = new Map(parsed.athletes);
            state.currentCheckpoint = parsed.currentCheckpoint;
            state.checkpointHistory = parsed.checkpointHistory;
            state.actionLog = parsed.actionLog;
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

// ========== CONFIGURATION SCREEN ==========
const configScreen = document.getElementById('configScreen');
const raceScreen = document.getElementById('raceScreen');
const totalLapsInput = document.getElementById('totalLaps');
const toggleButtons = document.querySelectorAll('.toggle-btn');
const btnStartConfig = document.getElementById('btnStartConfig');

// Toggle button handling
toggleButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        toggleButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

// ========== STARTING LIST FETCH ==========
function parseAthleteTable(table) {
    const athletes = [];
    for (const row of table.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;
        if (Array.from(cells).some(td => td.textContent.trim() === 'NP')) continue;
        // Try cells[0] first (e.g. rollergames.it format), fall back to cells[1]
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
        // Direct fetch failed (likely CORS) — retry via proxy
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
        statusEl.textContent = 'Impossibile caricare gli atleti: errore di rete o CORS. Verifica che l\'URL sia accessibile dal browser.';
        statusEl.className = 'load-status load-status-error';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Carica';
    }
});

// Start configuration
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

    // Add preloaded athletes from starting list (0 points)
    for (const data of preloadedAthletes) {
        if (!state.athletes.has(data.number)) {
            state.athletes.set(data.number, new Athlete(data.number, data.name, data.surname));
        }
    }
    preloadedAthletes = [];

    logAction(`Configurazione: ${laps} giri, Traguardo ${frequency === 'every_lap' ? 'ogni giro' : 'ogni 2 giri'}`);

    // Show race screen
    configScreen.classList.add('hidden');
    raceScreen.classList.remove('hidden');

    updateRaceHeader();
    renderLeaderboard();
});

// ========== RACE SCREEN ==========
const btnStartRace = document.getElementById('btnStartRace');
const btnEndRace = document.getElementById('btnEndRace');
const btnOpenKeyboard = document.getElementById('btnOpenKeyboard');
const btnUndo = document.getElementById('btnUndo');
const btnResetRace = document.getElementById('btnResetRace');
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

    // Determine which checkpoint to show
    let checkpointToShow = null;

    // If current checkpoint has assigned athletes, show it
    if (state.currentCheckpoint.assignedAthletes.length > 0) {
        checkpointToShow = {
            number: state.currentCheckpoint.number,
            athletes: state.currentCheckpoint.assignedAthletes
        };
    }
    // Otherwise, show the last checkpoint from history
    else if (state.checkpointHistory.length > 0) {
        const lastHistory = state.checkpointHistory[state.checkpointHistory.length - 1];
        checkpointToShow = {
            number: lastHistory.number,
            athletes: lastHistory.athletes
        };
    }

    // If no checkpoint to show, hide the summary
    if (!checkpointToShow || checkpointToShow.athletes.length === 0) {
        lastCheckpointSummary.classList.add('hidden');
        return;
    }

    // Sort athletes by points (descending)
    const sortedAthletes = [...checkpointToShow.athletes].sort((a, b) => b.points - a.points);

    // Build HTML
    let html = `<div class="last-checkpoint-summary-title">Ultimo traguardo ${checkpointToShow.number}:</div>`;
    html += `<ul class="last-checkpoint-summary-list">`;

    sortedAthletes.forEach(assignment => {
        const athlete = state.athletes.get(assignment.number);
        const nameDisplay = athlete && (athlete.name || athlete.surname)
            ? ` ${athlete.name || ''} ${athlete.surname || ''}`.trim()
            : '';
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

            // Export PDF
            exportToPDF();
        }
    );
}

function resetRace() {
    if (!isAdmin) return;
    showDialog(
        '🔄',
        'Riavviare la Gara?',
        'Tutti i dati della gara verranno cancellati e tornerai alla schermata di configurazione. Questa azione non può essere annullata. Vuoi continuare?',
        () => {
            // Clear localStorage
            clearLocalStorage();

            // Clear Firebase state
            if (isAdmin && typeof db !== 'undefined') {
                db.ref('race').remove().catch(err => console.error('Firebase remove error:', err));
            }

            // Reset all state
            state.config.totalLaps = 0;
            state.config.pointsFrequency = 'every_lap';
            state.raceStarted = false;
            state.raceEnded = false;
            state.lapsRemaining = 0;
            state.athletes.clear();
            state.currentCheckpoint = {
                number: 0,
                assignedAthletes: [],
                availablePoints: []
            };
            state.checkpointHistory = [];
            state.actionLog = [];

            // Reset UI
            raceScreen.classList.add('hidden');
            configScreen.classList.remove('hidden');

            // Reset config screen inputs
            totalLapsInput.value = '10';
            toggleButtons.forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.frequency === 'every_lap') {
                    btn.classList.add('active');
                }
            });

            // Hide all race buttons
            btnStartRace.classList.remove('hidden');
            btnEndRace.classList.add('hidden');
            btnOpenKeyboard.classList.add('hidden');
            btnUndo.classList.add('hidden');

            // Hide last checkpoint summary
            lastCheckpointSummary.classList.add('hidden');
            lastCheckpointSummary.innerHTML = '';

            console.log('Gara resettata completamente');
        }
    );
}

btnStartRace.addEventListener('click', startRace);
btnEndRace.addEventListener('click', endRace);
btnResetRace.addEventListener('click', resetRace);

// ========== CHECKPOINT MANAGEMENT ==========
function initializeCheckpoint() {
    state.currentCheckpoint.number++;
    state.currentCheckpoint.assignedAthletes = [];
    
    // Determine if it's the final checkpoint
    const isFinal = isNextCheckpointFinal();
    state.currentCheckpoint.availablePoints = isFinal ? [3, 2, 1] : [2, 1];
    
    console.log(`Checkpoint ${state.currentCheckpoint.number} inizializzato, Finale: ${isFinal}, Punti: ${state.currentCheckpoint.availablePoints}`);
}

function isNextCheckpointFinal() {
    if (state.config.pointsFrequency === 'every_lap') {
        return state.lapsRemaining === 1;
    } else {
        return state.lapsRemaining === 2;
    }
}

function canAssignPoints(points) {
    return state.currentCheckpoint.availablePoints.includes(points);
}

function isAthleteAlreadyAssignedInCheckpoint(athleteNumber) {
    return state.currentCheckpoint.assignedAthletes.some(a => a.number === athleteNumber);
}

function assignPointsToAthlete(athleteNumber, points, name = '', surname = '') {
    if (!isAdmin) return false;
    // Validation
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

    // Get or create athlete
    let athlete = state.athletes.get(athleteNumber);
    if (!athlete) {
        athlete = new Athlete(athleteNumber, name, surname);
        state.athletes.set(athleteNumber, athlete);
        const nameDisplay = name || surname ? ` (${name} ${surname})`.trim() : '';
        logAction(`Atleta #${athleteNumber}${nameDisplay} aggiunto alla classifica`);
    } else {
        // Update name/surname if athlete exists but doesn't have them yet
        if ((name && !athlete.name) || (surname && !athlete.surname)) {
            const oldNameDisplay = athlete.name || athlete.surname ? ` (${athlete.name} ${athlete.surname})`.trim() : '';

            if (name && !athlete.name) {
                athlete.name = name;
            }
            if (surname && !athlete.surname) {
                athlete.surname = surname;
            }

            const newNameDisplay = athlete.name || athlete.surname ? ` (${athlete.name} ${athlete.surname})`.trim() : '';
            logAction(`Atleta #${athleteNumber}: aggiornato${oldNameDisplay} →${newNameDisplay}`);
        }
    }

    // Check if disqualified
    if (athlete.status === 'disqualified') {
        alert(`❌ L'atleta #${athleteNumber} è squalificato. Riabilitalo prima di assegnare punti.`);
        return false;
    }

    // Check if this is the first point assignment
    const isFirstAssignment = state.currentCheckpoint.assignedAthletes.length === 0;

    // Assign points
    athlete.points += points;

    // Track assignment
    state.currentCheckpoint.assignedAthletes.push({ number: athleteNumber, points });

    // Remove from available points
    const index = state.currentCheckpoint.availablePoints.indexOf(points);
    state.currentCheckpoint.availablePoints.splice(index, 1);

    logAction(`Assegnati ${points} punti a #${athleteNumber} (Checkpoint ${state.currentCheckpoint.number})`);

    // Save or update checkpoint in history
    if (isFirstAssignment) {
        // First assignment: create new history entry
        state.checkpointHistory.push({
            number: state.currentCheckpoint.number,
            athletes: [...state.currentCheckpoint.assignedAthletes],
            lapsBeforeDecrement: state.lapsRemaining
        });
        updateUndoButton();
    } else {
        // Subsequent assignments: update the last history entry
        const lastHistory = state.checkpointHistory[state.checkpointHistory.length - 1];
        lastHistory.athletes = [...state.currentCheckpoint.assignedAthletes];
    }

    // Check if checkpoint is complete
    checkCheckpointCompletion();

    renderLeaderboard();
    updateKeyboardPoints();
    updateLastCheckpointSummary();

    return true;
}

function checkCheckpointCompletion() {
    const isFinal = state.currentCheckpoint.availablePoints.length === 0 && 
                   (state.currentCheckpoint.assignedAthletes.length === 3 || 
                    state.currentCheckpoint.assignedAthletes.length === 2);
    
    if (state.currentCheckpoint.availablePoints.length === 0) {
        completeCheckpoint();
    }
}

function completeCheckpoint() {
    // Decrement laps
    const decrement = state.config.pointsFrequency === 'every_lap' ? 1 : 2;
    state.lapsRemaining -= decrement;

    logAction(`Checkpoint ${state.currentCheckpoint.number} completato - Giri: ${state.lapsRemaining}`);

    // Check if race should end
    if (state.lapsRemaining === 0) {
        btnEndRace.classList.remove('hidden');
    }

    // Autosave
    saveToLocalStorage();

    // Close keyboard and menu
    closeKeyboard();
    closeAthleteMenu();

    // Initialize next checkpoint
    if (state.lapsRemaining > 0) {
        initializeCheckpoint();
    }

    // Update UI
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
            // Remove points from athletes
            lastCheckpoint.athletes.forEach(assignment => {
                const athlete = state.athletes.get(assignment.number);
                if (athlete) {
                    athlete.points -= assignment.points;
                    logAction(`Rimossi ${assignment.points} punti da #${assignment.number} (Undo Checkpoint ${lastCheckpoint.number})`);
                }
            });
            
            // Restore laps
            state.lapsRemaining = lastCheckpoint.lapsBeforeDecrement;
            
            // Remove from history
            state.checkpointHistory.pop();
            
            // Reset current checkpoint to the undone one
            state.currentCheckpoint.number = lastCheckpoint.number;
            state.currentCheckpoint.assignedAthletes = [];
            const isFinal = isNextCheckpointFinal();
            state.currentCheckpoint.availablePoints = isFinal ? [3, 2, 1] : [2, 1];
            
            // Hide end button if it was showing
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
    // Find the final checkpoint (the one with 3 points available)
    let finalCheckpoint = null;

    // Search through history for checkpoints with 3 points
    for (let i = state.checkpointHistory.length - 1; i >= 0; i--) {
        const checkpoint = state.checkpointHistory[i];
        // Check if this was a final checkpoint (had 3 points assignments possible)
        const had3Points = checkpoint.athletes.some(a => a.points === 3);
        if (had3Points) {
            finalCheckpoint = checkpoint;
            break;
        }
    }

    // If no final checkpoint in history yet, return null
    if (!finalCheckpoint) {
        return null;
    }

    // Find this athlete's assignment in the final checkpoint
    const assignment = finalCheckpoint.athletes.find(a => a.number === athleteNumber);

    if (assignment) {
        // Return both points and order (lower index = arrived first)
        const order = finalCheckpoint.athletes.findIndex(a => a.number === athleteNumber);
        return { points: assignment.points, order: order };
    }

    // Athlete didn't score in final checkpoint
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
            </div>
        `;
        return;
    }

    // Sort athletes with tiebreaker logic
    const sortedAthletes = Array.from(state.athletes.values())
        .sort((a, b) => {
            // First: disqualified athletes go to bottom (after lapped)
            if (a.status === 'disqualified' && b.status !== 'disqualified') return 1;
            if (a.status !== 'disqualified' && b.status === 'disqualified') return -1;

            // Second: lapped athletes go after normal, before disqualified
            if (a.status === 'lapped' && b.status !== 'lapped') return 1;
            if (a.status !== 'lapped' && b.status === 'lapped') return -1;

            // Third: sort by total points (descending)
            if (b.points !== a.points) {
                return b.points - a.points;
            }

            // Fourth: normal athletes at 0 points sort by number ascending
            if (a.status === 'normal' && a.points === 0) return a.number - b.number;

            // Fifth: if equal points > 0, sort by final checkpoint performance
            const aFinal = getFinalCheckpointPoints(a.number);
            const bFinal = getFinalCheckpointPoints(b.number);

            // If we have final checkpoint data, use it for tiebreaker
            if (aFinal && bFinal) {
                // First compare by points in final checkpoint (higher is better)
                if (bFinal.points !== aFinal.points) {
                    return bFinal.points - aFinal.points;
                }
                // If same points in final checkpoint, earlier arrival wins (lower order is better)
                return aFinal.order - bFinal.order;
            }

            return 0;
        });
    
    let html = `
        <table class="leaderboard-table">
            <thead>
                <tr>
                    <th style="width: 60px;">Pos.</th>
                    <th style="width: 80px;">Numero</th>
                    <th>Cognome</th>
                    <th>Nome</th>
                    <th style="width: 80px;">Punti</th>
                    <th style="width: 60px;">Stato</th>
                </tr>
            </thead>
            <tbody>
    `;

    sortedAthletes.forEach((athlete, index) => {
        const position = index + 1;
        const positionClass = position === 1 ? 'position-1' :
                             position === 2 ? 'position-2' :
                             position === 3 ? 'position-3' : 'position-other';

        const statusIcon = athlete.status === 'lapped' ? '🔄' :
                          athlete.status === 'disqualified' ? '❌' : '';

        const rowClass = state.raceEnded ? '' : '';
        const clickable = !state.raceEnded && isAdmin;

        html += `
            <tr class="${rowClass}" data-athlete="${athlete.number}" ${clickable ? 'style="cursor: pointer;"' : ''}>
                <td>
                    <span class="position-badge ${positionClass}">${position}</span>
                </td>
                <td>
                    <span class="athlete-number">#${athlete.number}</span>
                </td>
                <td>
                    <span class="athlete-surname">${athlete.surname || ''}</span>
                </td>
                <td>
                    <span class="athlete-name">${athlete.name || ''}</span>
                </td>
                <td>
                    <span class="athlete-points">${athlete.points}</span>
                </td>
                <td>
                    <span class="athlete-status">${statusIcon}</span>
                </td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    leaderboardContent.innerHTML = html;
    
    // Add click handlers for athlete rows (admin only)
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
    if (state.raceEnded) return;

    currentMenuAthlete = athleteNumber;
    const athlete = state.athletes.get(athleteNumber);

    // Update athlete number in header
    document.getElementById('athleteMenuNumber').textContent = `Atleta #${athleteNumber}`;

    // Get menu items
    const menuAssignPointsSection = document.getElementById('menuAssignPointsSection');
    const menuModifyPoints = document.getElementById('menuModifyPoints');
    const menuEditAthlete = document.getElementById('menuEditAthlete');
    const menuLap = document.getElementById('menuLap');
    const menuUnlap = document.getElementById('menuUnlap');
    const menuDisqualify = document.getElementById('menuDisqualify');
    const menuReinstate = document.getElementById('menuReinstate');
    const menuDivider2 = document.getElementById('menuDivider2');

    // Hide edit athlete submenu if visible
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    editSubmenu.classList.add('hidden');

    // Remove old listeners by cloning all menu items
    [menuModifyPoints, menuEditAthlete, menuLap, menuUnlap, menuDisqualify, menuReinstate].forEach(item => {
        const newItem = item.cloneNode(true);
        item.parentNode.replaceChild(newItem, item);
    });

    // Get the new cloned elements
    const newMenuModifyPoints = document.getElementById('menuModifyPoints');
    const newMenuEditAthlete = document.getElementById('menuEditAthlete');
    const newMenuLap = document.getElementById('menuLap');
    const newMenuUnlap = document.getElementById('menuUnlap');
    const newMenuDisqualify = document.getElementById('menuDisqualify');
    const newMenuReinstate = document.getElementById('menuReinstate');

    // Hide all items first
    menuAssignPointsSection.classList.add('hidden');
    newMenuModifyPoints.classList.add('hidden');
    newMenuEditAthlete.classList.add('hidden');
    newMenuLap.classList.add('hidden');
    newMenuUnlap.classList.add('hidden');
    newMenuDisqualify.classList.add('hidden');
    newMenuReinstate.classList.add('hidden');
    menuDivider2.classList.add('hidden');

    // Show items based on athlete status
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

    // Update assign points buttons
    updateAssignPointsButtons(athleteNumber);

    // Add event listeners to visible items
    athleteMenu.querySelectorAll('.menu-item:not(.hidden)').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            handleMenuAction(item.dataset.action);
        });
    });

    // Clone and replace close button to remove old listeners
    const closeBtn = document.getElementById('menuCloseBtn');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

    // Add new close button listener
    document.getElementById('menuCloseBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeAthleteMenu();
    });

    athleteMenu.classList.remove('hidden');

    // Position menu
    positionMenu(event);
}

function positionMenu(event) {
    // Center the menu in the viewport
    athleteMenu.style.left = '50%';
    athleteMenu.style.top = '50%';
    athleteMenu.style.transform = 'translate(-50%, -50%)';
    athleteMenu.style.maxHeight = `${Math.min(500, window.innerHeight - 40)}px`;
    athleteMenu.style.overflowY = 'auto';
}

function closeAthleteMenu() {
    // Remove any dynamic submenu (modify points submenu)
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) {
        existingSubmenu.remove();
    }

    // Hide edit athlete submenu
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    if (editSubmenu) {
        editSubmenu.classList.add('hidden');
    }

    athleteMenu.classList.add('hidden');
    currentMenuAthlete = null;
}

function updateAssignPointsButtons(athleteNumber) {
    const points = state.currentCheckpoint.availablePoints;
    const buttonsContainer = document.getElementById('menuAssignPointsButtons');

    // Get all buttons and update their state
    const buttons = buttonsContainer.querySelectorAll('.submenu-btn');
    buttons.forEach(btn => {
        const pointValue = parseInt(btn.dataset.points);
        const disabled = !points.includes(pointValue);
        btn.disabled = disabled;

        // Clone to remove old listeners
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
    });

    // Add event listeners to all buttons
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
        case 'modify-points':
            showModifyPointsSubmenu(athleteNumber);
            break;
        case 'edit-athlete':
            showEditAthleteSubmenu(athleteNumber);
            break;
        case 'lap':
            lapAthlete(athleteNumber);
            closeAthleteMenu();
            break;
        case 'disqualify':
            disqualifyAthlete(athleteNumber);
            closeAthleteMenu();
            break;
        case 'unlap':
            unlapAthlete(athleteNumber);
            closeAthleteMenu();
            break;
        case 'reinstate':
            reinstateAthlete(athleteNumber);
            closeAthleteMenu();
            break;
    }
}

function showModifyPointsSubmenu(athleteNumber) {
    // Remove any existing dynamic submenu (but keep the static sections)
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) {
        existingSubmenu.remove();
    }

    // Hide the assign points section and edit athlete submenu
    const assignPointsSection = document.getElementById('menuAssignPointsSection');
    assignPointsSection.classList.add('hidden');

    const editAthleteSubmenu = document.getElementById('menuEditAthleteSubmenu');
    editAthleteSubmenu.classList.add('hidden');

    // Create submenu element
    const submenu = document.createElement('div');
    submenu.className = 'submenu';

    // Create title
    const title = document.createElement('div');
    title.className = 'submenu-title';
    title.textContent = 'Modifica Punti (indipendente dai giri)';
    submenu.appendChild(title);

    // Create buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'submenu-buttons';

    // Create buttons
    ['+1', '+2', '+3', '-1', '-2', '-3'].forEach(modifyValue => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'submenu-btn';
        btn.dataset.modify = modifyValue;
        btn.textContent = modifyValue;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const modify = parseInt(modifyValue);
            modifyAthletePointsFree(athleteNumber, modify);
            closeAthleteMenu();
        });

        buttonsContainer.appendChild(btn);
    });

    submenu.appendChild(buttonsContainer);

    // Insert before the static assign points section
    athleteMenu.insertBefore(submenu, assignPointsSection);
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

    // Remove any existing dynamic submenu (modify points submenu)
    const existingSubmenu = athleteMenu.querySelector('.submenu:not(#menuAssignPointsSection):not(#menuEditAthleteSubmenu)');
    if (existingSubmenu) {
        existingSubmenu.remove();
    }

    // Hide all menu items except the submenu
    const menuItems = athleteMenu.querySelectorAll('.menu-item');
    menuItems.forEach(item => item.classList.add('hidden'));

    const menuDividers = athleteMenu.querySelectorAll('.menu-divider');
    menuDividers.forEach(divider => divider.classList.add('hidden'));

    const assignPointsSection = document.getElementById('menuAssignPointsSection');
    assignPointsSection.classList.add('hidden');

    // Show the edit athlete submenu
    const editSubmenu = document.getElementById('menuEditAthleteSubmenu');
    editSubmenu.classList.remove('hidden');

    // Populate inputs with current athlete data
    document.getElementById('editAthleteNumber').value = athlete.number;
    document.getElementById('editAthleteName').value = athlete.name || '';
    document.getElementById('editAthleteSurname').value = athlete.surname || '';

    // Clone and replace buttons to remove old listeners
    const btnConfirm = document.getElementById('btnConfirmEditAthlete');
    const btnCancel = document.getElementById('btnCancelEditAthlete');

    const newBtnConfirm = btnConfirm.cloneNode(true);
    const newBtnCancel = btnCancel.cloneNode(true);

    btnConfirm.parentNode.replaceChild(newBtnConfirm, btnConfirm);
    btnCancel.parentNode.replaceChild(newBtnCancel, btnCancel);

    // Add event listeners to new buttons
    document.getElementById('btnConfirmEditAthlete').addEventListener('click', (e) => {
        e.stopPropagation();
        editAthlete(athleteNumber);
    });

    document.getElementById('btnCancelEditAthlete').addEventListener('click', (e) => {
        e.stopPropagation();
        closeAthleteMenu();
    });
}

function editAthlete(originalAthleteNumber) {
    const athlete = state.athletes.get(originalAthleteNumber);
    if (!athlete) return;

    // Get new values from inputs
    const newNumberInput = document.getElementById('editAthleteNumber').value.trim();
    const newName = document.getElementById('editAthleteName').value.trim();
    const newSurname = document.getElementById('editAthleteSurname').value.trim();

    // Validate number is not empty
    if (!newNumberInput) {
        showDialog('⚠️', 'Errore', 'Il numero atleta è obbligatorio.', true);
        // Reset to original number
        document.getElementById('editAthleteNumber').value = athlete.number;
        return;
    }

    const newNumber = parseInt(newNumberInput);
    if (isNaN(newNumber) || newNumber <= 0) {
        showDialog('⚠️', 'Errore', 'Il numero atleta deve essere un valore positivo.', true);
        // Reset to original number
        document.getElementById('editAthleteNumber').value = athlete.number;
        return;
    }

    // Check if new number already exists (and is different from original)
    if (newNumber !== originalAthleteNumber && state.athletes.has(newNumber)) {
        showDialog('⚠️', 'Errore', `Il numero #${newNumber} è già assegnato ad un altro atleta.`, true);
        // Reset to original number
        document.getElementById('editAthleteNumber').value = athlete.number;
        return;
    }

    // Update athlete data
    const oldDisplayName = athlete.name || athlete.surname ? ` (${athlete.name || ''} ${athlete.surname || ''})`.trim() : '';

    athlete.name = newName || null;
    athlete.surname = newSurname || null;

    const newDisplayName = athlete.name || athlete.surname ? ` (${athlete.name || ''} ${athlete.surname || ''})`.trim() : '';

    // If number changed, update Map and all references
    if (newNumber !== originalAthleteNumber) {
        athlete.number = newNumber;

        // Update athletes Map
        state.athletes.delete(originalAthleteNumber);
        state.athletes.set(newNumber, athlete);

        // Update checkpointHistory
        state.checkpointHistory.forEach(checkpoint => {
            checkpoint.athletes.forEach(assignment => {
                if (assignment.number === originalAthleteNumber) {
                    assignment.number = newNumber;
                }
            });
        });

        // Update currentCheckpoint
        state.currentCheckpoint.assignedAthletes.forEach(assignment => {
            if (assignment.number === originalAthleteNumber) {
                assignment.number = newNumber;
            }
        });

        logAction(`Atleta #${originalAthleteNumber}${oldDisplayName} modificato → #${newNumber}${newDisplayName}`);

        // Update currentMenuAthlete to the new number
        currentMenuAthlete = newNumber;

        // Update menu header
        document.getElementById('athleteMenuNumber').textContent = `Atleta #${newNumber}`;
    } else {
        // Only name/surname changed
        if (oldDisplayName !== newDisplayName) {
            logAction(`Atleta #${originalAthleteNumber}${oldDisplayName} modificato →${newDisplayName}`);
        }
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

    const checkpointInfo = state.currentCheckpoint.number > 0 ? ` - Checkpoint ${state.currentCheckpoint.number}` : '';
    logAction(`Atleta #${athleteNumber} doppiato (${athlete.savedPoints} punti conservati)${checkpointInfo}`);
    saveToLocalStorage();
    renderLeaderboard();
}

function unlapAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete || athlete.status !== 'lapped') return;

    athlete.points = athlete.savedPoints;
    athlete.savedPoints = 0;
    athlete.status = 'normal';

    const checkpointInfo = state.currentCheckpoint.number > 0 ? ` - Checkpoint ${state.currentCheckpoint.number}` : '';
    logAction(`Atleta #${athleteNumber} sdoppiato (${athlete.points} punti ripristinati)${checkpointInfo}`);
    saveToLocalStorage();
    renderLeaderboard();
}

function disqualifyAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete) return;

    // If lapped, save those points instead
    if (athlete.status === 'lapped') {
        athlete.savedPoints = athlete.savedPoints; // Keep saved points from lapping
    } else {
        athlete.savedPoints = athlete.points;
    }

    athlete.points = 0;
    athlete.status = 'disqualified';

    const checkpointInfo = state.currentCheckpoint.number > 0 ? ` - Checkpoint ${state.currentCheckpoint.number}` : '';
    logAction(`Atleta #${athleteNumber} squalificato (${athlete.savedPoints} punti conservati)${checkpointInfo}`);
    saveToLocalStorage();
    renderLeaderboard();
}

function reinstateAthlete(athleteNumber) {
    const athlete = state.athletes.get(athleteNumber);
    if (!athlete || athlete.status !== 'disqualified') return;

    athlete.points = athlete.savedPoints;
    athlete.savedPoints = 0;
    athlete.status = 'normal';

    const checkpointInfo = state.currentCheckpoint.number > 0 ? ` - Checkpoint ${state.currentCheckpoint.number}` : '';
    logAction(`Atleta #${athleteNumber} riabilitato (${athlete.points} punti ripristinati)${checkpointInfo}`);
    saveToLocalStorage();
    renderLeaderboard();
}

// Close menu when clicking outside (using mousedown to handle text selection properly)
document.addEventListener('mousedown', (e) => {
    // Don't close if clicking inside the menu or on a leaderboard row
    if (e.target.closest('#athleteMenu') || e.target.closest('.leaderboard-table tbody tr')) {
        return;
    }
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
    // Focus on number input
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
    document.querySelectorAll('.keyboard-key').forEach(key => {
        key.disabled = !enabled;
    });
}

// Disable keyboard keys when focus is on name or surname fields
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
        // Existing athlete: auto-fill and disable name/surname fields
        inputAthleteName.value = existingAthlete.name || '';
        inputAthleteSurname.value = existingAthlete.surname || '';
        inputAthleteName.disabled = true;
        inputAthleteSurname.disabled = true;
    } else {
        // New athlete: clear and enable name/surname fields
        inputAthleteName.value = '';
        inputAthleteSurname.value = '';
        inputAthleteName.disabled = false;
        inputAthleteSurname.disabled = false;
    }
}

function updateKeyboardPoints() {
    const points = state.currentCheckpoint.availablePoints;

    // Get button elements
    const btnPoints3 = document.getElementById('btnPoints3');
    const btnPoints2 = document.getElementById('btnPoints2');
    const btnPoints1 = document.getElementById('btnPoints1');

    // Enable/disable buttons based on available points
    btnPoints3.disabled = !points.includes(3);
    btnPoints2.disabled = !points.includes(2);
    btnPoints1.disabled = !points.includes(1);

    // Add event listeners
    keyboardPointsGrid.querySelectorAll('.keyboard-points-btn').forEach(btn => {
        // Remove old listeners by cloning
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
    });

    keyboardPointsGrid.querySelectorAll('.keyboard-points-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const athleteNumber = inputAthleteNumber.value.trim();

            if (athleteNumber === '') {
                alert('❌ Inserisci il numero dell\'atleta');
                inputAthleteNumber.focus();
                return;
            }

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

// Prevent non-numeric input in number field and auto-fill name/surname
inputAthleteNumber.addEventListener('input', (e) => {
    // Remove any non-numeric characters
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
    updateKeyboardPointsButtons();

    // Auto-fill name and surname if athlete exists
    const athleteNumber = parseInt(e.target.value);
    if (!isNaN(athleteNumber) && athleteNumber > 0) {
        const athlete = state.athletes.get(athleteNumber);
        if (athlete) {
            // Existing athlete: auto-fill and disable name/surname fields
            inputAthleteName.value = athlete.name || '';
            inputAthleteSurname.value = athlete.surname || '';
            inputAthleteName.disabled = true;
            inputAthleteSurname.disabled = true;
        } else {
            // New athlete: clear and enable name/surname fields
            inputAthleteName.value = '';
            inputAthleteSurname.value = '';
            inputAthleteName.disabled = false;
            inputAthleteSurname.disabled = false;
        }
    } else {
        // Clear and enable fields if number is not valid
        inputAthleteName.value = '';
        inputAthleteSurname.value = '';
        inputAthleteName.disabled = false;
        inputAthleteSurname.disabled = false;
    }
});

inputAthleteNumber.addEventListener('keypress', (e) => {
    // Prevent typing non-numeric characters
    if (!/[0-9]/.test(e.key) && e.key !== 'Enter' && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'Tab') {
        e.preventDefault();
    }
});

// Update button states when number changes
function updateKeyboardPointsButtons() {
    const hasNumber = inputAthleteNumber.value.trim() !== '';
    const points = state.currentCheckpoint.availablePoints;

    const btnPoints3 = document.getElementById('btnPoints3');
    const btnPoints2 = document.getElementById('btnPoints2');
    const btnPoints1 = document.getElementById('btnPoints1');

    // Disable if no number OR if points not available
    btnPoints3.disabled = !hasNumber || !points.includes(3);
    btnPoints2.disabled = !hasNumber || !points.includes(2);
    btnPoints1.disabled = !hasNumber || !points.includes(1);
}

// Keyboard key handling - updates number input
document.querySelectorAll('.keyboard-key').forEach(key => {
    key.addEventListener('click', () => {
        const value = key.dataset.key;

        if (value === 'C') {
            inputAthleteNumber.value = '';
        } else if (value === 'backspace') {
            inputAthleteNumber.value = inputAthleteNumber.value.slice(0, -1);
        } else {
            inputAthleteNumber.value += value;
        }

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
    if (dialogCallback) {
        dialogCallback();
    }
    closeDialog();
});

// ========== FIREBASE SYNC ==========
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();
const auth = firebase.auth();
const raceRef = db.ref('race');

// Helper: converts Firebase value (may be object with numeric keys) back to array
function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    return Object.values(val);
}

// Writes current state to Firebase (admin only)
function pushToFirebase() {
    const athletesObj = {};
    state.athletes.forEach((athlete, number) => {
        athletesObj[String(number)] = {
            number: athlete.number,
            name: athlete.name || '',
            surname: athlete.surname || '',
            points: athlete.points,
            status: athlete.status,
            savedPoints: athlete.savedPoints
        };
    });

    const checkpointHistorySerialized = state.checkpointHistory.map(cp => ({
        number: cp.number,
        lapsBeforeDecrement: cp.lapsBeforeDecrement,
        athletes: cp.athletes || []
    }));

    raceRef.set({
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
        checkpointHistory: checkpointHistorySerialized
    }).catch(err => console.error('Firebase write error:', err));
}

// Applies Firebase data to local state and updates UI
function applyFirebaseState(data) {
    if (!data) return;

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
            const a = new Athlete(
                athleteData.number,
                athleteData.name || '',
                athleteData.surname || ''
            );
            a.points = athleteData.points || 0;
            a.status = athleteData.status || 'normal';
            a.savedPoints = athleteData.savedPoints || 0;
            state.athletes.set(athleteData.number, a);
        });
    }

    configScreen.classList.add('hidden');
    raceScreen.classList.remove('hidden');
    updateRaceHeader();
    renderLeaderboard();
    updateLastCheckpointSummary();
    updateUndoButton();
}

// Activates viewer mode: read-only, subscribes to Firebase
function activateViewerMode() {
    isAdmin = false;

    // Show login button, hide admin badge
    document.getElementById('btnAdminLogin').classList.remove('hidden');
    document.getElementById('adminBadge').classList.add('hidden');
    document.getElementById('adminBadgeConfig').classList.add('hidden');

    // Hide all admin controls
    btnStartRace.classList.add('hidden');
    btnEndRace.classList.add('hidden');
    btnOpenKeyboard.classList.add('hidden');
    btnUndo.classList.add('hidden');
    btnResetRace.classList.add('hidden');

    // Switch to race screen (viewers never see config)
    configScreen.classList.add('hidden');
    raceScreen.classList.remove('hidden');

    // Subscribe to Firebase for live updates
    if (!_firebaseListenerActive) {
        _firebaseListenerActive = true;
        raceRef.on('value', (snapshot) => {
            if (isAdmin) return; // Guard: don't overwrite admin state
            const data = snapshot.val();
            if (data) {
                applyFirebaseState(data);
            } else {
                // No race data: show waiting message
                badgeConfig.textContent = '-';
                badgeLaps.textContent = 'Giri rimanenti: -';
                leaderboardContent.innerHTML = `
                    <div class="empty-leaderboard">
                        <div class="empty-leaderboard-icon">🏆</div>
                        <p>In attesa della prossima gara...</p>
                    </div>
                `;
            }
        });
    }
}

// Activates admin mode: full controls, writes to Firebase
function activateAdminMode() {
    isAdmin = true;

    // Detach viewer listener (admin writes directly, doesn't need to listen)
    if (_firebaseListenerActive) {
        raceRef.off();
        _firebaseListenerActive = false;
    }

    // Show admin badge, hide login button
    document.getElementById('btnAdminLogin').classList.add('hidden');
    document.getElementById('adminBadge').classList.remove('hidden');
    document.getElementById('adminBadgeConfig').classList.remove('hidden');

    // Show reset button (always visible for admin)
    btnResetRace.classList.remove('hidden');

    // Try to recover state from localStorage first (fast, on same device)
    const hasLocalState = loadFromLocalStorage();
    if (hasLocalState) {
        configScreen.classList.add('hidden');
        raceScreen.classList.remove('hidden');
        updateRaceHeader();
        renderLeaderboard();
        if (state.raceStarted) {
            btnStartRace.classList.add('hidden');
            btnOpenKeyboard.classList.remove('hidden');
        }
        if (state.lapsRemaining === 0 && state.raceStarted && !state.raceEnded) {
            btnEndRace.classList.remove('hidden');
        }
        updateUndoButton();
        updateLastCheckpointSummary();
    } else {
        // No local state: try Firebase (e.g. admin on a new device)
        raceRef.once('value').then(snapshot => {
            const data = snapshot.val();
            if (data && data.raceStarted) {
                applyFirebaseState(data);
                saveToLocalStorage(); // Local backup
                if (state.raceStarted) {
                    btnStartRace.classList.add('hidden');
                    btnOpenKeyboard.classList.remove('hidden');
                }
                if (state.lapsRemaining === 0 && !state.raceEnded) {
                    btnEndRace.classList.remove('hidden');
                }
                updateUndoButton();
            } else {
                // No race anywhere: show config screen
                configScreen.classList.remove('hidden');
                raceScreen.classList.add('hidden');
            }
        });
    }
}

// ========== AUTH STATE LISTENER ==========
auth.onAuthStateChanged((user) => {
    // Hide loading overlay once auth state is known
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

document.getElementById('btnLogout').addEventListener('click', () => auth.signOut());
document.getElementById('btnLogoutConfig').addEventListener('click', () => auth.signOut());

// ========== PDF EXPORT ==========
function exportToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Title
    doc.setFontSize(20);
    doc.text('Speed Skating Race Point', 105, 20, { align: 'center' });

    // Configuration info
    doc.setFontSize(12);
    const checkpointText = state.config.pointsFrequency === 'every_lap' ? 'Ogni giro' : 'Ogni 2 giri';
    const configText = state.config.totalLaps.toString() + ' giri totali, Traguardi: ' + checkpointText;
    doc.text('Configurazione: ' + configText, 105, 30, { align: 'center' });

    // Date and time
    const now = new Date();
    const dateStr = now.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    doc.setFontSize(10);
    doc.text(`Esportato il ${dateStr} alle ${timeStr}`, 105, 37, { align: 'center' });

    // Leaderboard header
    doc.setFontSize(14);
    doc.text('Classifica Finale', 20, 50);

    // Get sorted athletes with tiebreaker logic (same as renderLeaderboard)
    const sortedAthletes = Array.from(state.athletes.values()).sort((a, b) => {
        // First: disqualified athletes go to bottom (after lapped)
        if (a.status === 'disqualified' && b.status !== 'disqualified') return 1;
        if (a.status !== 'disqualified' && b.status === 'disqualified') return -1;

        // Second: lapped athletes go after normal, before disqualified
        if (a.status === 'lapped' && b.status !== 'lapped') return 1;
        if (a.status !== 'lapped' && b.status === 'lapped') return -1;

        // Third: sort by total points (descending)
        if (b.points !== a.points) {
            return b.points - a.points;
        }

        // Fourth: if equal points, sort by final checkpoint performance
        const aFinal = getFinalCheckpointPoints(a.number);
        const bFinal = getFinalCheckpointPoints(b.number);

        // If we have final checkpoint data, use it for tiebreaker
        if (aFinal && bFinal) {
            // First compare by points in final checkpoint (higher is better)
            if (bFinal.points !== aFinal.points) {
                return bFinal.points - aFinal.points;
            }
            // If same points in final checkpoint, earlier arrival wins (lower order is better)
            return aFinal.order - bFinal.order;
        }

        // No tiebreaker available, keep original order
        return 0;
    });

    // Table headers
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    let yPos = 60;
    doc.text('Pos', 20, yPos);
    doc.text('Num', 35, yPos);
    doc.text('Nome', 55, yPos);
    doc.text('Cognome', 95, yPos);
    doc.text('Punti', 140, yPos);
    doc.text('Stato', 165, yPos);

    // Draw line under header
    doc.line(20, yPos + 2, 190, yPos + 2);

    // Table rows
    doc.setFont(undefined, 'normal');
    yPos += 10;

    sortedAthletes.forEach((athlete, index) => {
        // Check if we need a new page
        if (yPos > 270) {
            doc.addPage();
            yPos = 20;
        }

        const position = athlete.status === 'disqualified' ? 'SQ' :
                        athlete.status === 'lapped' ? 'D' :
                        (index + 1).toString();

        const statusText = athlete.status === 'disqualified' ? 'Squalificato' :
                          athlete.status === 'lapped' ? 'Doppiato' :
                          '';

        doc.text(position, 20, yPos);
        doc.text(`#${athlete.number}`, 35, yPos);
        doc.text(athlete.name || '', 55, yPos);
        doc.text(athlete.surname || '', 95, yPos);
        doc.text(athlete.points.toString(), 140, yPos);
        if (statusText) {
            doc.text(statusText, 165, yPos);
        }

        yPos += 7;
    });

    // Add checkpoints summary section
    yPos += 10; // Extra spacing
    if (yPos > 250) {
        doc.addPage();
        yPos = 20;
    }

    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text('Riepilogo Traguardi', 20, yPos);
    yPos += 10;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');

    // Build checkpoint summary from checkpointHistory (excludes undone checkpoints)
    if (state.checkpointHistory && state.checkpointHistory.length > 0) {
        // Sort checkpoints in reverse order (last checkpoint first)
        const sortedCheckpoints = [...state.checkpointHistory].sort((a, b) => b.number - a.number);

        sortedCheckpoints.forEach(checkpoint => {
            const parts = [];

            // Add points assignments
            if (checkpoint.athletes && checkpoint.athletes.length > 0) {
                // Sort athletes by points in descending order
                const sortedAthletes = [...checkpoint.athletes].sort((a, b) => b.points - a.points);

                sortedAthletes.forEach(assignment => {
                    const athlete = state.athletes.get(assignment.number);
                    const nameDisplay = athlete && (athlete.name || athlete.surname)
                        ? ` ${athlete.name || ''} ${athlete.surname || ''}`.trim()
                        : '';
                    const separator = nameDisplay ? ' ' : '';
                    parts.push(`#${assignment.number}${separator}${nameDisplay} (${assignment.points}pt)`);
                });
            }

            if (parts.length > 0) {
                if (yPos > 275) {
                    doc.addPage();
                    yPos = 20;
                }

                const line = `Traguardo ${checkpoint.number}: ${parts.join('; ')}`;
                const splitText = doc.splitTextToSize(line, 170);

                splitText.forEach(textLine => {
                    if (yPos > 275) {
                        doc.addPage();
                        yPos = 20;
                    }
                    doc.text(textLine, 20, yPos);
                    yPos += 6;
                });
            }
        });
    } else {
        doc.text('Nessun traguardo completato', 20, yPos);
    }

    // Footer on last page
    doc.setFontSize(8);
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.text(`Pagina ${i} di ${pageCount}`, 105, 287, { align: 'center' });
        doc.text('Generato da Speed Skating Race Point', 105, 292, { align: 'center' });
    }

    // Save PDF
    const filename = `gara_punti_${dateStr.replace(/\//g, '-')}_${timeStr.replace(/:/g, '-')}.pdf`;
    doc.save(filename);
}

