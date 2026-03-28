/**
 * firebase-config.js
 * ════════════════════════════════════════════════════════════════
 * Firebase V9 Modular SDK initialisatie voor Boerenbridge.
 *
 * INSTRUCTIES VOOR GEBRUIK:
 * 1. Ga naar https://console.firebase.google.com
 * 2. Maak een nieuw project aan (of open bestaand project)
 * 3. Klik op "Web app" (</> icoon) om een web-app toe te voegen
 * 4. Kopieer het `firebaseConfig` object en plak het hieronder
 *    ter vervanging van de placeholder-waarden.
 * 5. Zorg dat Firestore Database is ingeschakeld in je project
 *    (Firestore Database → Create database → Start in test mode)
 *
 * FIRESTORE SECURITY RULES (voor productie, pas aan):
 *   rules_version = '2';
 *   service cloud.firestore {
 *     match /databases/{database}/documents {
 *       match /{document=**} {
 *         allow read, write: if true; // Pas aan voor authenticatie
 *       }
 *     }
 *   }
 * ════════════════════════════════════════════════════════════════
 */

// Firebase V9 SDK via CDN (ESM)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ────────────────────────────────────────────────────────────────
// ► PLAK HIER JE EIGEN firebaseConfig OBJECT
// ────────────────────────────────────────────────────────────────
const firebaseConfig =  {
  apiKey: "AIzaSyDs4yxzeiXP4jXD-8qHyofDPU7JunPKQPk",
  authDomain: "boerenbridge-scores.firebaseapp.com",
  projectId: "boerenbridge-scores",
  storageBucket: "boerenbridge-scores.firebasestorage.app",
  messagingSenderId: "335407164464",
  appId: "1:335407164464:web:e7477e23ce0b854e7c51f5",
  measurementId: "G-B2EF78W84T"
};// ────────────────────────────────────────────────────────────────

// Initialiseer Firebase app
const app = initializeApp(firebaseConfig);

/**
 * Firestore database instantie.
 * Wordt geïmporteerd door database-service.js voor alle CRUD operaties.
 * @type {import('firebase/firestore').Firestore}
 */
export const db = getFirestore(app);

// Exporteer ook de app instantie voor eventuele toekomstige uitbreidingen
// (bijv. Firebase Auth, Storage)
export { app };
