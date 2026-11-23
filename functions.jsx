const HERO_SECTIONS = ["Hero1", "Hero2", "Hero3"]

/** Répartit les 3 Adventurers posés en Hero1 sur Hero1, Hero2 et Hero3, puis règle leurs PV de départ */
async function ini() {
    const adventurers = [...(cards?.Hero1 ?? [])]
    if (adventurers.length === 0) return

    for (let i = 1; i < adventurers.length && i < HERO_SECTIONS.length; i++) {
        await functions.moveCard(adventurers[i], HERO_SECTIONS[i])
    }

    adventurers.slice(0, HERO_SECTIONS.length).forEach((card, i) => {
        const hp = Number(functions.getCardData(card)?.hp)
        game.data.HP["hp" + (i + 1)] = Number.isFinite(hp) ? hp : 0
    })

    await functions.repositionCards()
}

/** Met à jour les PV de l'Adventurer n° index (1 à 3) affichés devant lui */
function setHp(index, value) {
    game.data.HP["hp" + index] = value
}