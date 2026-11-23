#!/usr/bin/env node
/**
 * Génère JourneyCards.json (liste de cartes TCG Arena) et les images des cartes à partir de la page Cardlist
 * du site officiel The Journey TCG.
 *
 *  - Source : https://www.journeytcg.com/cardlist (site Wix). Les galeries de cartes sont lues dans le bloc
 *    <script id="wix-warmup-data"> de la page : nom du fichier image, image, titre (version des promos)
 *  - Chaque galerie de la page correspond à une catégorie (type + faction), voir GALLERIES
 *  - id et nom officiels (imprimés sur la carte) lus dans cardInfo.json, indexé par fichier image Wix.
 *    Une image absente de cardInfo.json reçoit un id provisoire "TMP_…" et un nom tiré du nom de fichier,
 *    et est signalée dans le rapport
 *  - Les promos / alt arts / box toppers ont le même nom que la carte de base → TCG Arena les regroupe en skins
 *  - Images : l'original est téléchargé une fois dans Scripts/.cache/originals/, puis recadré sur le bord de la
 *    carte (marge transparente et pastilles du site retirées, coins arrondis conservés) et enregistré en WebP
 *    dans Images/Cards/<id>.webp. Une image n'est retraitée que si son fichier source change (images-manifest.json)
 *  - Une carte qui disparaît de la page est conservée telle quelle (aucune carte perdue pour les decks existants)
 *  - Rapport dans Scripts/cardlist-report.md
 *
 * Emplacement : Scripts/updateCards.js, JourneyCards.json et Images/ sont dans le dossier parent
 * Usage       : node updateCards.js                  (télécharge la page)
 *               node updateCards.js page.html        (lit une page enregistrée depuis le navigateur)
 *               FORCE=1 node updateCards.js          (écrit même si beaucoup de cartes manquent)
 *               FORCE_IMAGES=1 node updateCards.js   (retraite toutes les images)
 * Dépendances : Node 18+, sharp (npm install sharp)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// ─────────────────────────────── Configuration ───────────────────────────────

const ROOT = path.join(__dirname, '..');

const CONFIG = {
    pageUrl: 'https://www.journeytcg.com/cardlist',
    wixMediaBase: 'https://static.wixstatic.com/media/',
    imagesBaseUrl: 'https://valcur.github.io/TCG-Arena-Journey/Images/Cards/',
    cardsFile: path.join(ROOT, 'JourneyCards.json'),
    imagesDir: path.join(ROOT, 'Images', 'Cards'),
    originalsDir: path.join(__dirname, '.cache', 'originals'),
    cardInfoFile: path.join(__dirname, 'cardInfo.json'),
    imagesManifestFile: path.join(__dirname, 'images-manifest.json'),
    reportPath: path.join(__dirname, 'cardlist-report.md'),
    setName: 'Brave Exodus',
    promoSetName: 'Promo',
    webpQuality: 90,
    cornerRadiusRatio: 48 / 754,   // rayon des coins / largeur de la carte
    downloadConcurrency: 6,
    minRatioVsPrevious: 0.8,
};

/** Galeries de la page (id du composant Wix) → catégorie des cartes qu'elle contient, dans l'ordre de la page */
const GALLERIES = {
    'comp-lyw6v07y': { type: 'Adventurer', faction: 'Warrior' },
    'comp-lyw7kt12': { type: 'Ability', faction: 'Warrior' },
    'comp-lyw7kz6b': { type: 'Adventurer', faction: 'Mage' },
    'comp-lyw7vmq8': { type: 'Ability', faction: 'Mage' },
    'comp-lyw81vyq': { type: 'Adventurer', faction: 'Augmentor' },
    'comp-lyw5o2t7': { type: 'Ability', faction: 'Augmentor' },
    'comp-lyw821l0': { type: 'Adventurer', faction: 'Divine' },
    'comp-lywzipi9': { type: 'Ability', faction: 'Divine' },
    'comp-lywzmi68': { type: 'Item' },
    'comp-lyw7vsyu': { type: 'Equipment' },
    'comp-mr3sbcl6': { promo: true },
};

const LOWERCASE_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'to', 'for']);

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = [];
function report(level, category, id, message) { issues.push({ level, category, id: String(id), message: message || '' }); }

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

/** Majuscule à chaque mot, sauf les petits mots hors première position ("ghost note" → "Ghost Note") */
function titleCase(s) {
    return clean(s).split(' ').map((w, i) => {
        if (i > 0 && LOWERCASE_WORDS.has(w.toLowerCase())) return w.toLowerCase();
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
}

/** Nom provisoire tiré du fichier : "Dual Strike 2_edited_edited.png" → "Dual Strike" */
function nameFromFile(fileName, isPromo) {
    let n = clean(fileName).replace(/\.[a-z0-9]+$/i, '').replace(/(_edited)+/gi, '').replace(/_/g, ' ');
    n = clean(n).replace(/\s+\d+$/, '');
    if (isPromo) n = n.replace(/\s+round edge$/i, '').replace(/\s+alt$/i, '').replace(/^(alt|white)\s+/i, '');
    return titleCase(n);
}

/** "Zina's Hairpin" → "ZinasHairpin" */
function pascal(s) {
    return clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '')
        .split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/** "f62c35_97554a6e2e3d4310b4b18777cf7f45ff~mv2.png" → "97554a6e" */
function mediaHash(mediaUrl) {
    const m = String(mediaUrl).match(/_([0-9a-f]{8})[0-9a-f]*~/i);
    return m ? m[1] : pascal(mediaUrl).slice(0, 8);
}

/** Clé de tri d'un id officiel : numéro de carte, puis id complet ("A-BEX-044" → 44) */
function idNumber(id) {
    const m = String(id).match(/BEX-(\d+|INF)/i);
    if (!m) return 99999;
    return m[1].toUpperCase() === 'INF' ? 9999 : Number(m[1]);
}

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.basename(file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', content);
    await fsp.rename(file + '.tmp', file);
}

// ─────────────────────────────── Lecture de la page ───────────────────────────────

async function loadPage() {
    const local = process.argv[2];
    if (local) return fsp.readFile(path.resolve(local), 'utf8');
    const res = await fetch(CONFIG.pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (TCG Arena card list generator)' } });
    if (!res.ok) throw new FatalError(`${CONFIG.pageUrl} : HTTP ${res.status}`);
    return res.text();
}

/** Retourne { compId: { items, total } } pour chaque galerie trouvée dans wix-warmup-data */
function extractGalleries(html) {
    const m = html.match(/<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new FatalError('Bloc wix-warmup-data introuvable dans la page (structure du site modifiée ?)');
    let warmup;
    try { warmup = JSON.parse(m[1]); } catch (e) { throw new FatalError(`wix-warmup-data illisible : ${e.message}`); }

    const galleries = {};
    for (const app of Object.values(warmup.appsWarmupData || {})) {
        for (const [key, value] of Object.entries(app || {})) {
            const g = key.match(/^(comp-[a-z0-9]+)_galleryData$/i);
            if (!g || !Array.isArray(value?.items)) continue;
            galleries[g[1]] = { items: value.items, total: value.totalItemsCount ?? value.items.length };
        }
    }
    if (!Object.keys(galleries).length) throw new FatalError('Aucune galerie de cartes trouvée dans wix-warmup-data');
    return galleries;
}

// ─────────────────────────────── Images ───────────────────────────────

/** Télécharge les originaux absents du cache */
async function downloadOriginals(mediaFiles) {
    await fsp.mkdir(CONFIG.originalsDir, { recursive: true });
    const queue = mediaFiles.filter(f => !fs.existsSync(path.join(CONFIG.originalsDir, f)));
    let done = 0;
    async function worker() {
        while (queue.length) {
            const file = queue.shift();
            const target = path.join(CONFIG.originalsDir, file);
            try {
                const res = await fetch(CONFIG.wixMediaBase + encodeURIComponent(file));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                await fsp.writeFile(target + '.tmp', Buffer.from(await res.arrayBuffer()));
                await fsp.rename(target + '.tmp', target);
                done++;
                process.stdout.write(`\r⬇️  ${done} image(s) téléchargée(s)`);
            } catch (e) {
                report('error', 'Images impossibles à télécharger', file, e.message);
            }
        }
    }
    await Promise.all(Array.from({ length: CONFIG.downloadConcurrency }, worker));
    if (done) process.stdout.write('\n');
    return done;
}

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/**
 * Rectangle de la carte dans l'image : bords gauche/droit mesurés sur les lignes du milieu, haut/bas sur les
 * colonnes entre 15 et 30 % de la largeur, pour ignorer les pastilles du site (bas au centre et coin bas droit)
 */
function cardBounds(alpha, width, height) {
    const opaque = (x, y) => alpha[y * width + x] > 128;
    const lefts = [], rights = [];
    for (let y = Math.floor(height * 0.4); y < Math.floor(height * 0.6); y++) {
        let l = 0; while (l < width && !opaque(l, y)) l++;
        let r = width - 1; while (r >= 0 && !opaque(r, y)) r--;
        if (l <= r) { lefts.push(l); rights.push(r); }
    }
    if (!lefts.length) return null;
    const left = median(lefts), right = median(rights);
    const cardWidth = right - left + 1;
    const tops = [], bottoms = [];
    for (let x = left + Math.floor(cardWidth * 0.15); x < left + Math.floor(cardWidth * 0.3); x++) {
        let t = 0; while (t < height && !opaque(x, t)) t++;
        let b = height - 1; while (b >= 0 && !opaque(x, b)) b--;
        if (t <= b) { tops.push(t); bottoms.push(b); }
    }
    if (!tops.length) return null;
    const top = median(tops), bottom = median(bottoms);
    return { left, top, width: cardWidth, height: bottom - top + 1 };
}

/** Recadre l'original sur la carte, applique les coins arrondis et l'enregistre en WebP */
async function processImage(sourceFile, targetFile) {
    const input = sharp(sourceFile).ensureAlpha();
    const { data, info } = await input.clone().raw().toBuffer({ resolveWithObject: true });
    const alpha = new Uint8Array(info.width * info.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * info.channels + 3];

    let box = cardBounds(alpha, info.width, info.height);
    if (!box || box.width < info.width * 0.7 || box.height < info.height * 0.7) {
        report('warning', 'Bord de carte introuvable (image gardée entière)', path.basename(sourceFile), '');
        box = { left: 0, top: 0, width: info.width, height: info.height };
    }

    const radius = Math.round(box.width * CONFIG.cornerRadiusRatio);
    const mask = Buffer.from(`<svg width="${box.width}" height="${box.height}"><rect width="${box.width}" height="${box.height}" rx="${radius}" ry="${radius}"/></svg>`);
    const buffer = await input
        .extract(box)
        .composite([{ input: mask, blend: 'dest-in' }])
        .webp({ quality: CONFIG.webpQuality, alphaQuality: 100 })
        .toBuffer();
    await writeFileAtomic(targetFile, buffer);
    return { width: box.width, height: box.height };
}

/** Génère Images/Cards/<id>.webp pour chaque carte dont l'image source a changé */
async function buildImages(cards) {
    const manifest = await readJsonIfExists(CONFIG.imagesManifestFile, {});
    await downloadOriginals([...new Set(cards.map(c => c.mediaFile))]);
    await fsp.mkdir(CONFIG.imagesDir, { recursive: true });

    let processed = 0;
    for (const card of cards) {
        const source = path.join(CONFIG.originalsDir, card.mediaFile);
        const target = path.join(CONFIG.imagesDir, `${card.id}.webp`);
        if (!fs.existsSync(source)) continue;
        const upToDate = manifest[card.id] === card.mediaFile && fs.existsSync(target);
        if (upToDate && process.env.FORCE_IMAGES !== '1') continue;
        try {
            await processImage(source, target);
            manifest[card.id] = card.mediaFile;
            processed++;
            process.stdout.write(`\r🖼️  ${processed} image(s) traitée(s)`);
        } catch (e) {
            report('error', 'Images impossibles à traiter', card.id, e.message);
        }
    }
    if (processed) process.stdout.write('\n');
    await writeFileAtomic(CONFIG.imagesManifestFile, JSON.stringify(manifest, null, 2) + '\n');
    return processed;
}

// ─────────────────────────────── Format JourneyCards.json ───────────────────────────────

function buildCardEntry({ id, name, type, faction, isHorizontal, set }) {
    const image = CONFIG.imagesBaseUrl + encodeURIComponent(id) + '.webp';
    const entry = {
        id,
        face: {
            front: { name, type, cost: 0, image, isHorizontal },
        },
        name,
        type,
        cost: 0,
        faction,
        set,
    };
    return JSON.parse(JSON.stringify(entry));
}

// ─────────────────────────────── Rapport ───────────────────────────────

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const lines = [];
    lines.push(`# Liste des cartes The Journey TCG — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    for (const g of summary.galleries) lines.push(`| ${g.id} (${g.label}) | ${g.count} cartes |`);
    lines.push(`| Cartes dans ${path.basename(CONFIG.cardsFile)} | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Noms différents (cartes jouables) | ${summary.nameCount} |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Cartes disparues de la page (conservées) | ${summary.kept.length} |`);
    lines.push(`| Images traitées | ${summary.imagesProcessed} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${path.basename(CONFIG.cardsFile)} n'a PAS été modifié.`, '');

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.forEach(i => lines.push(`- \`${i.id}\`${i.message ? ' — ' + i.message : ''}`));
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.added.length && summary.previousCount) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        summary.added.forEach(e => lines.push(`- \`${e.id}\` ${e.name} (${e.set})`));
        lines.push('');
    }
    return lines.join('\n');
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 30).forEach(i => console.log(`   - ${i.id}${i.message ? ' : ' + i.message : ''}`));
            if (items.length > 30) console.log(`   … et ${items.length - 30} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = { galleries: [], cardCount: 0, previousCount: 0, nameCount: 0, imagesProcessed: 0, added: [], kept: [], fatal: null };

    try {
        // ── 1. Page, galeries et ids officiels ──
        const galleries = extractGalleries(await loadPage());
        for (const id of Object.keys(GALLERIES)) {
            if (!galleries[id]) report('error', 'Galeries attendues mais absentes de la page (mettre à jour GALLERIES)', id, '');
        }
        for (const [id, g] of Object.entries(galleries)) {
            if (!GALLERIES[id]) report('error', 'Galeries inconnues (ignorées, à ajouter dans GALLERIES)', id,
                `${g.items.length} cartes : ${g.items.slice(0, 5).map(i => i.metaData?.fileName).join(', ')}…`);
            if (g.total > g.items.length) report('warning', 'Galeries incomplètes dans la page (cartes manquantes)', id, `${g.items.length} / ${g.total}`);
        }
        const cardInfo = await readJsonIfExists(CONFIG.cardInfoFile, {});
        if (!Object.keys(cardInfo).length) report('warning', 'cardInfo.json absent ou vide (ids provisoires partout)', path.basename(CONFIG.cardInfoFile), '');

        const previousCards = await readJsonIfExists(CONFIG.cardsFile, {});
        summary.previousCount = Object.keys(previousCards).length;

        // ── 2. Cartes ──
        const built = [];
        const usedIds = new Set();
        const usedMedia = new Set();
        const baseByName = new Map();

        const readItem = (galleryId, item, isPromo) => {
            const md = item.metaData || {};
            if (!item.mediaUrl || !md.fileName) { report('error', 'Cartes sans image ou sans nom de fichier (ignorées)', galleryId, item.itemId); return null; }
            usedMedia.add(item.mediaUrl);
            const info = cardInfo[item.mediaUrl];
            let id = clean(info?.id);
            const name = clean(info?.name) || nameFromFile(md.fileName, isPromo);
            if (!id) {
                id = `TMP_${pascal(name)}_${mediaHash(item.mediaUrl)}`;
                report('warning', 'Cartes sans id officiel (à ajouter dans cardInfo.json)', id,
                    `"${item.mediaUrl}": { "id": "", "name": "${name}" } — ${CONFIG.wixMediaBase}${item.mediaUrl}`);
            }
            if (usedIds.has(id)) {
                report('error', 'Identifiants en double dans cardInfo.json (carte ignorée)', id, md.fileName);
                return null;
            }
            usedIds.add(id);
            return { id, name, mediaFile: item.mediaUrl, isHorizontal: Number(md.width) > Number(md.height), title: clean(md.title) };
        };

        for (const [galleryId, cat] of Object.entries(GALLERIES)) {
            if (cat.promo || !galleries[galleryId]) continue;
            const label = [cat.faction, cat.type].filter(Boolean).join(' ');
            let count = 0;
            for (const item of galleries[galleryId].items) {
                const card = readItem(galleryId, item, false);
                if (!card) continue;
                if (baseByName.has(card.name)) report('warning', 'Cartes de base avec le même nom (regroupées en skins)', card.id, card.name);
                else baseByName.set(card.name, cat);
                built.push({ ...card, type: cat.type, faction: cat.faction, set: CONFIG.setName, promo: false });
                count++;
            }
            summary.galleries.push({ id: galleryId, label, count });
        }

        for (const [galleryId, cat] of Object.entries(GALLERIES)) {
            if (!cat.promo || !galleries[galleryId]) continue;
            let count = 0;
            for (const item of galleries[galleryId].items) {
                const card = readItem(galleryId, item, true);
                if (!card) continue;
                const base = baseByName.get(card.name);
                if (!base) report('warning', 'Promos sans carte de base du même nom (vérifier le nom dans cardInfo.json)', card.id, card.name);
                built.push({ ...card, type: base?.type || 'Unknown', faction: base?.faction, set: card.title || CONFIG.promoSetName, promo: true });
                count++;
            }
            summary.galleries.push({ id: galleryId, label: 'Promos', count });
        }

        for (const media of Object.keys(cardInfo)) {
            if (!usedMedia.has(media)) report('warning', 'Entrées de cardInfo.json absentes de la page', cardInfo[media]?.id || media, media);
        }

        if (!built.length) throw new FatalError('Aucune carte lue dans la page');
        if (summary.previousCount && built.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${built.length} cartes contre ${summary.previousCount} dans le fichier actuel. ` +
                'Relancer avec FORCE=1 pour écraser quand même.');
        }

        // ── 3. Images ──
        summary.imagesProcessed = await buildImages(built);
        for (const card of built) {
            if (!fs.existsSync(path.join(CONFIG.imagesDir, `${card.id}.webp`))) report('error', 'Cartes sans image générée', card.id, card.name);
        }

        // ── 4. Liste triée : cartes de base par numéro, puis promos ──
        built.sort((a, b) => (a.promo - b.promo) || (idNumber(a.id) - idNumber(b.id)) || a.id.localeCompare(b.id));
        const out = {};
        const order = [];
        for (const card of built) {
            out[card.id] = buildCardEntry(card);
            order.push(card.id);
        }

        // ── 5. Comparaison avec l'ancienne liste ──
        summary.added = order.filter(id => !(id in previousCards)).map(id => out[id]);
        for (const [id, prev] of Object.entries(previousCards)) {
            if (out[id]) continue;
            out[id] = prev;
            order.push(id);
            summary.kept.push(id);
            report('warning', 'Cartes disparues de la page (conservées telles quelles)', id, prev?.name || '');
        }

        // ── 6. Écriture ──
        await writeFileAtomic(CONFIG.cardsFile, JSON.stringify(Object.fromEntries(order.map(id => [id, out[id]])), null, 2) + '\n');
        summary.cardCount = order.length;
        summary.nameCount = new Set(Object.values(out).map(e => e.name)).size;

        console.log(`💾 ${path.basename(CONFIG.cardsFile)} écrit : ${summary.cardCount} cartes, ${summary.nameCount} noms différents ` +
            `(${summary.added.length} nouvelles, ${summary.kept.length} disparues de la page conservées, ${summary.imagesProcessed} images traitées)`);
        for (const g of summary.galleries) console.log(`   ${g.label.padEnd(22)} ${String(g.count).padStart(4)} cartes`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    await writeFileAtomic(CONFIG.reportPath, buildReport(summary)).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(process.cwd(), CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
