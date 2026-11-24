const HERO_SECTIONS = ["Hero1", "Hero2", "Hero3"]
const HERO_INDEXES = [1, 2, 3]

/** Log préfixé pour filtrer facilement la console */
function log(...args) {
    console.log("[Journey]", ...args)
}

/** Position du joueur local dans l'ordre de la table (clé de ses données dans le bloc partagé Order) */
function myPosition() {
    return game.turn.orderPosition ?? 0
}

/** Clé d'un Adventurer dans Order.active : "position-emplacement" (emplacement 0 à 2) */
function heroKey(position, slot) {
    return `${position}-${slot}`
}

/** "Hyla, Bog Lurker" → "Hyla" */
function shortName(name) {
    return String(name ?? "").split(",")[0].trim()
}

function toNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
}

function isSet(value) {
    return value !== null && value !== undefined
}

// ─────────────────────────────── Initialisation ───────────────────────────────

/**
 * Répartit les 3 Adventurers posés en Hero1 sur Hero1, Hero2 et Hero3 et remplit le bloc Stats du joueur
 * (nom, PV, Agility, Step Back, action faite). L'hôte tire aussi le joueur qui a la priorité au premier tour.
 */
async function ini() {
    const adventurers = [...(cards?.Hero1 ?? [])].slice(0, HERO_SECTIONS.length)
    log("ini: position", myPosition(), "/ host", game.isHost, "/", adventurers.length, "Adventurer(s) in Hero1")

    if (game.isHost && !isSet(game.data.Order.priorityStart)) {
        game.data.Order.priorityStart = Math.floor(Math.random() * Math.max(1, game.turn.totalPlayers))
        log("ini: random starting priority player", game.data.Order.priorityStart)
    }

    if (adventurers.length === 0) return

    for (let i = 1; i < adventurers.length; i++) {
        log("ini: moving to", HERO_SECTIONS[i])
        await functions.moveCard(adventurers[i], HERO_SECTIONS[i])
    }

    game.data.Stats.position = myPosition()
    adventurers.forEach((card, i) => {
        const data = functions.getCardData(card)
        const n = i + 1
        game.data.Stats["name" + n] = shortName(data?.name)
        game.data.Stats["hp" + n] = toNumber(data?.hp)
        game.data.Stats["agi" + n] = toNumber(data?.agility)
        game.data.Stats["step" + n] = false
        game.data.Stats["done" + n] = false
        log(`ini: Adventurer ${n} = ${game.data.Stats["name" + n]}, HP ${game.data.Stats["hp" + n]}, Agility ${game.data.Stats["agi" + n]}`)
    })

    await functions.repositionCards()
}

// ─────────────────────────────── Actions du joueur (bloc Stats) ───────────────────────────────

/** PV de l'Adventurer n° index (1 à 3) */
function setHp(index, value) {
    game.data.Stats["hp" + index] = toNumber(value)
    log(`setHp: Adventurer ${index} -> ${game.data.Stats["hp" + index]} HP`)
}

/** Agility totale de l'Adventurer n° index (1 à 3) */
function setAgi(index, value) {
    game.data.Stats["agi" + index] = toNumber(value)
    log(`setAgi: Adventurer ${index} -> Agility ${game.data.Stats["agi" + index]}`)
}

/** Step Back de l'Adventurer n° index (1 à 3) : une seule fois par tour */
function stepBack(index) {
    if (game.data.Stats["step" + index]) {
        log(`stepBack: Adventurer ${index} already stepped back this turn`)
        return
    }
    game.data.Stats["step" + index] = true
    log(`stepBack: Adventurer ${index} (${game.data.Stats["name" + index]})`)
}

/** Pass : marque comme ayant agi tous les Adventurers du joueur dont c'est actuellement le tour */
function pass() {
    const active = game.data.Order.active ?? []
    const passed = []
    HERO_INDEXES.forEach((n, slot) => {
        if (active.includes(heroKey(myPosition(), slot)) && !game.data.Stats["done" + n]) {
            game.data.Stats["done" + n] = true
            passed.push(game.data.Stats["name" + n])
        }
    })
    log("pass:", passed.length ? passed.join(", ") : "no Adventurer of mine was active", "/ active:", active)
}

/** Nouveau tour : chaque joueur récupère ses Step Back et ses actions ; l'hôte passe la priorité au joueur suivant */
function newTurn() {
    log("newTurn: turn", game.turn.count, "/ my turn", game.turn.isMyTurn)
    for (const n of HERO_INDEXES) {
        if (game.data.Stats["step" + n]) game.data.Stats["step" + n] = false
        if (game.data.Stats["done" + n]) game.data.Stats["done" + n] = false
    }
    if (game.isHost) rebuildOrder()
}

// ─────────────────────────────── Hôte : bloc partagé Order ───────────────────────────────

/** onUpdate du bloc Stats : l'hôte reporte ses propres stats et son pseudo dans Order */
function onMyStatsUpdate() {
    if (!game.isHost) return
    log("onMyStatsUpdate: host stats changed")
    storeStats({ ...game.data.Stats, position: myPosition() }, game.data.pseudo)
}

/** onOpponentUpdate du bloc Stats : l'hôte reporte les stats et le pseudo de l'adversaire dans Order */
function onOpponentStats(opponentData) {
    if (!game.isHost) return
    const stats = opponentData?.Stats
    if (!isSet(stats?.position)) {
        log("onOpponentStats: data without position, ignored", opponentData)
        return
    }
    log("onOpponentStats: player at position", stats.position, "/ pseudo", opponentData?.pseudo)
    storeStats(stats, opponentData?.pseudo)
}

/** Enregistre les Adventurers d'un joueur (nom, Agility, Step Back, action faite) et son pseudo dans Order, puis recalcule l'ordre */
function storeStats(stats, pseudo) {
    const previous = game.data.Order.players?.[stats.position]
    const entry = {
        position: stats.position,
        pseudo: pseudo || previous?.pseudo || "",
        heroes: HERO_INDEXES.map(n => ({
            name: stats["name" + n] ?? "",
            agi: toNumber(stats["agi" + n]),
            step: !!stats["step" + n],
            done: !!stats["done" + n],
        })),
    }
    game.data.Order.players = { ...(game.data.Order.players ?? {}), [entry.position]: entry }
    log("storeStats: position", entry.position, "/ pseudo", entry.pseudo, entry.heroes)
    rebuildOrder()
}

/**
 * Recalcule l'affichage de la barre et les Adventurers dont c'est le tour.
 * - list : tous les Adventurers de tous les joueurs, hors Step Back d'abord, puis par Agility décroissante.
 *   sep = séparateur affiché avant l'élément ("›" Agility différente, "=" égalité, "" pour le premier).
 * - active : clés "position-emplacement" des Adventurers qui n'ont pas encore agi et qui partagent la meilleure
 *   place restante (même groupe Step Back, même Agility). Le groupe suivant devient actif quand tous ont passé.
 * - priority : joueur tiré au premier tour, puis le joueur suivant à chaque nouveau tour.
 */
function rebuildOrder() {
    const players = Object.values(game.data.Order.players ?? {})
        .filter(p => p && isSet(p.position))
        .sort((a, b) => a.position - b.position)

    const heroes = []
    for (const p of players) {
        p.heroes.forEach((h, slot) => {
            if (h.name) heroes.push({ ...h, position: p.position, slot })
        })
    }
    heroes.sort((a, b) => (a.step - b.step) || (b.agi - a.agi) || (a.position - b.position) || (a.slot - b.slot))

    game.data.Order.list = heroes.map((h, i) => {
        const prev = heroes[i - 1]
        const tie = prev && prev.step === h.step && prev.agi === h.agi
        return { name: h.name, position: h.position, slot: h.slot, step: h.step, done: h.done, sep: i === 0 ? "" : tie ? "=" : "›" }
    })

    const remaining = heroes.filter(h => !h.done)
    const first = remaining[0]
    game.data.Order.active = first
        ? remaining.filter(h => h.step === first.step && h.agi === first.agi).map(h => heroKey(h.position, h.slot))
        : []

    const total = Math.max(1, game.turn.totalPlayers)
    if (isSet(game.data.Order.priorityStart)) {
        game.data.Order.priority = (toNumber(game.data.Order.priorityStart) + toNumber(game.turn.count)) % total
    }

    log("rebuildOrder:", game.data.Order.list.map(h => h.sep + h.name + (h.done ? "(done)" : "")).join(" "),
        "| active:", game.data.Order.active, "| priority: position", game.data.Order.priority)
}
