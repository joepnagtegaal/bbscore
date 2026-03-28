/**
 * database-service.js
 * ════════════════════════════════════════════════════════════════
 * Alle asynchrone Firestore-logica voor Boerenbridge.
 *
 * COLLECTIES:
 *   players → { name: string, createdAt: Timestamp }
 *   games   → { date: Timestamp, participants: string[],
 *                rounds: RoundData[], finalScores: FinalScore[],
 *                completed: boolean }
 *
 * DESIGN PRINCIPE:
 *   - Alle DB-functies zijn async en gooien errors door naar de caller.
 *   - game-logic.js is verantwoordelijk voor error handling / UI feedback.
 *   - Geen UI-logica in dit bestand.
 * ════════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ─── COLLECTIE-NAMEN (centraal gedefinieerd) ───────────────────
const COL_PLAYERS = 'players';
const COL_GAMES   = 'games';

/* ════════════════════════════════════════════════════════════════
   SPELER FUNCTIES
   ════════════════════════════════════════════════════════════════ */

/**
 * Haal alle spelers op, gesorteerd op naam.
 * @returns {Promise<Array<{id: string, name: string, createdAt: Date}>>}
 */
export async function getAllPlayers() {
  const q = query(
    collection(db, COL_PLAYERS),
    orderBy('name', 'asc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({
    id: d.id,
    name: d.data().name,
    createdAt: d.data().createdAt?.toDate() ?? new Date()
  }));
}

/**
 * Zoek spelers op naam (case-insensitive prefix search).
 * Firestore ondersteunt geen native case-insensitive search;
 * we halen alle spelers op en filteren client-side.
 * @param {string} query - zoekterm
 * @param {Array} allPlayers - gecachede spelerlijst
 * @returns {Array} gefilterde spelers
 */
export function filterPlayers(query, allPlayers) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allPlayers.filter(p => p.name.toLowerCase().includes(q));
}

/**
 * Voeg een nieuwe speler toe aan de database.
 * @param {string} name - naam van de speler
 * @returns {Promise<{id: string, name: string}>}
 */
export async function addPlayer(name) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Naam mag niet leeg zijn');
  if (trimmedName.length > 50) throw new Error('Naam te lang (max. 50 tekens)');

  const docRef = await addDoc(collection(db, COL_PLAYERS), {
    name: trimmedName,
    createdAt: serverTimestamp()
  });
  return { id: docRef.id, name: trimmedName };
}

/* ════════════════════════════════════════════════════════════════
   SPEL FUNCTIES
   ════════════════════════════════════════════════════════════════ */

/**
 * Maak een nieuw, leeg spel-document in Firestore.
 * Wordt aangeroepen bij het starten van een spel.
 *
 * @param {string[]} participantNames - namen van de spelers in volgorde
 * @returns {Promise<string>} - het document-ID van het nieuwe spel
 */
export async function createGame(participantNames) {
  const docRef = await addDoc(collection(db, COL_GAMES), {
    date:         serverTimestamp(),
    participants: participantNames,
    rounds:       [],           // Wordt per ronde bijgewerkt
    finalScores:  [],           // Wordt ingevuld na het laatste ronde
    completed:    false
  });
  return docRef.id;
}

/**
 * Sla de resultaten van een afgeronde ronde op in Firestore.
 * Werkt het 'rounds' array bij via updateDoc + arrayUnion (of volledige update).
 *
 * We slaan het volledige rondes-array op (niet arrayUnion) zodat
 * correcties later ook correct worden opgeslagen.
 *
 * @param {string} gameId         - Firestore document ID van het spel
 * @param {Array}  roundsData     - Compleet array met alle ronde-data
 * @returns {Promise<void>}
 */
export async function saveGameRounds(gameId, roundsData) {
  const gameRef = doc(db, COL_GAMES, gameId);
  await updateDoc(gameRef, {
    rounds: roundsData
  });
}

/**
 * Markeer het spel als voltooid en sla de eindscores op.
 * Wordt alleen aangeroepen nadat alle 15 rondes zijn gespeeld.
 *
 * @param {string} gameId        - Firestore document ID
 * @param {Array}  roundsData    - Alle 15 ronde-data objecten
 * @param {Array}  finalScores   - [{playerName, totalScore, rank}]
 * @returns {Promise<void>}
 */
export async function finalizeGame(gameId, roundsData, finalScores) {
  const gameRef = doc(db, COL_GAMES, gameId);
  await updateDoc(gameRef, {
    rounds:      roundsData,
    finalScores: finalScores,
    completed:   true,
    completedAt: serverTimestamp()
  });
}

/* ════════════════════════════════════════════════════════════════
   STATISTIEKEN & RECORDS
   ════════════════════════════════════════════════════════════════ */

/**
 * Haal alle voltooide spellen op voor statistieken.
 * @returns {Promise<Array>} - alle completed games
 */
export async function getCompletedGames() {
  const q = query(
    collection(db, COL_GAMES),
    where('completed', '==', true),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Bereken globale records uit alle voltooide spellen.
 * Records worden client-side berekend (geen Cloud Functions nodig).
 *
 * @returns {Promise<GlobalRecords>}
 *
 * GlobalRecords = {
 *   highestFinalScore: { value, playerName, date, witnesses },
 *   lowestFinalScore:  { value, playerName, date, witnesses },
 *   highestRoundScore: { value, playerName, round, date, witnesses },
 *   lowestRoundScore:  { value, playerName, round, date, witnesses },
 *   playerStats:       Map<playerName, PlayerStats>
 * }
 *
 * PlayerStats = {
 *   totalGames:      number,
 *   totalRounds:     number,
 *   correctBids:     number,
 *   correctPct:      number,    // alleen als totalGames >= 5
 *   avgRank:         number,    // alleen als totalGames >= 5
 *   winCount:        number,
 *   scores:          number[]   // alle eindscores
 * }
 */
export async function calculateGlobalRecords() {
  const games = await getCompletedGames();

  // Initialiseer record-houders
  let highestFinal = null;
  let lowestFinal  = null;
  let highestRound = null;
  let lowestRound  = null;

  // Map voor speler-statistieken
  const playerStats = new Map();

  /**
   * Helper: haal of initialiseer een speler-stats object.
   */
  function getPlayerStats(name) {
    if (!playerStats.has(name)) {
      playerStats.set(name, {
        totalGames:  0,
        totalRounds: 0,
        correctBids: 0,
        ranks:       [],    // rangorde per spel
        scores:      []     // eindscores
      });
    }
    return playerStats.get(name);
  }

  // Verwerk elk spel
  for (const game of games) {
    const participants = game.participants || [];
    const rounds       = game.rounds       || [];
    const finalScores  = game.finalScores  || [];
    const gameDate     = game.date?.toDate?.() ?? new Date();
    const witnesses    = participants.slice(); // alle deelnemers als getuigen

    // ── Verwerk eindscores ──
    for (const fs of finalScores) {
      const stats = getPlayerStats(fs.playerName);
      stats.totalGames++;
      stats.scores.push(fs.totalScore);
      stats.ranks.push(fs.rank);

      // Hoogste eindscore?
      if (highestFinal === null || fs.totalScore > highestFinal.value) {
        highestFinal = {
          value:      fs.totalScore,
          playerName: fs.playerName,
          date:       gameDate,
          witnesses:  witnesses.filter(w => w !== fs.playerName)
        };
      }
      // Laagste eindscore?
      if (lowestFinal === null || fs.totalScore < lowestFinal.value) {
        lowestFinal = {
          value:      fs.totalScore,
          playerName: fs.playerName,
          date:       gameDate,
          witnesses:  witnesses.filter(w => w !== fs.playerName)
        };
      }
    }

    // ── Verwerk ronde-scores ──
    rounds.forEach((round, roundIndex) => {
      if (!round.playerData) return;

      for (const [playerName, data] of Object.entries(round.playerData)) {
        const stats = getPlayerStats(playerName);
        stats.totalRounds++;

        // Was het bod correct gehaald?
        if (data.bid === data.tricks) {
          stats.correctBids++;
        }

        const roundScore = data.score ?? 0;

        // Hoogste ronde-score?
        if (highestRound === null || roundScore > highestRound.value) {
          highestRound = {
            value:      roundScore,
            playerName,
            round:      roundIndex + 1,
            date:       gameDate,
            witnesses:  witnesses.filter(w => w !== playerName)
          };
        }
        // Laagste ronde-score?
        if (lowestRound === null || roundScore < lowestRound.value) {
          lowestRound = {
            value:      roundScore,
            playerName,
            round:      roundIndex + 1,
            date:       gameDate,
            witnesses:  witnesses.filter(w => w !== playerName)
          };
        }
      }
    });
  }

  // ── Bereken afgeleide statistieken per speler ──
  const playerStatsResult = {};
  for (const [name, stats] of playerStats.entries()) {
    const avgRank        = stats.ranks.length > 0
      ? stats.ranks.reduce((a, b) => a + b, 0) / stats.ranks.length
      : null;
    const correctPct     = stats.totalRounds > 0
      ? (stats.correctBids / stats.totalRounds) * 100
      : null;
    const wins           = stats.ranks.filter(r => r === 1).length;
    const avgScore       = stats.scores.length > 0
      ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
      : null;

    playerStatsResult[name] = {
      totalGames:  stats.totalGames,
      totalRounds: stats.totalRounds,
      correctBids: stats.correctBids,
      // Correct percentage alleen relevant bij >= 5 potjes
      correctPct:  stats.totalGames >= 5 ? correctPct : null,
      // Gemiddelde rank alleen relevant bij >= 5 potjes
      avgRank:     stats.totalGames >= 5 ? avgRank    : null,
      winCount:    wins,
      avgScore,
      scores:      stats.scores
    };
  }

  return {
    highestFinalScore: highestFinal,
    lowestFinalScore:  lowestFinal,
    highestRoundScore: highestRound,
    lowestRoundScore:  lowestRound,
    playerStats:       playerStatsResult
  };
}

/**
 * Haal alle spellen op waaraan een specifieke speler heeft deelgenomen.
 * @param {string} playerName
 * @returns {Promise<Array>}
 */
export async function getGamesForPlayer(playerName) {
  const q = query(
    collection(db, COL_GAMES),
    where('completed', '==', true),
    where('participants', 'array-contains', playerName),
    orderBy('date', 'desc')
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}
