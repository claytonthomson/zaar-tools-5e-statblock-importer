export class sbiDnd5eActorBuilder {
    constructor(actor) {
        this.actor = actor;
    }

    async create(selectedFolderId, destinationOptions = {}) {
        await this.actor.updateActorData();

        const destination = destinationOptions.destination ?? "world";
        const actorClass = CONFIG.Actor.documentClass;

        if (!actorClass.canUserCreate(game.user)) {
            throw new Error("You do not have permission to create Actors.");
        }

        const operation = {};

        if (destination === "world") {
            if (selectedFolderId) {
                const folder = game.folders.get(selectedFolderId);
                if (!folder || folder.type !== "Actor") {
                    throw new Error("The selected World Actor folder is no longer available.");
                }
            }
        } else if (destination === "compendium") {
            const packId = destinationOptions.packId;
            const pack = packId ? game.packs.get(packId) : null;

            if (!pack) {
                throw new Error("The selected Actor compendium is no longer available.");
            }
            if (pack.documentName !== "Actor") {
                throw new Error("The selected compendium does not contain Actors.");
            }
            if (pack.locked) {
                throw new Error("The selected Actor compendium is locked.");
            }
            if (!pack.testUserPermission(game.user, "OWNER")) {
                throw new Error("You no longer have sufficient permission to create Actors in the selected compendium.");
            }
            if (selectedFolderId && !pack.folders.has(selectedFolderId)) {
                throw new Error("The selected compendium Actor folder is no longer available.");
            }

            operation.pack = pack.collection;
        } else {
            throw new Error(`Unknown Actor import destination: ${destination}`);
        }

        const actorData = foundry.utils.deepClone(this.actor.actorData);
        actorData.folder = selectedFolderId;
        actorData.name = this.actor.name;
        actorData.type = "npc";

        const actor5e = await actorClass.create(actorData, operation);
        if (actor5e) {
            await this.actor.setSkills(actor5e);

            // Check if AC needs fixed (if mage armor, skip check)
            if (this.actor.armor && !this.actor.armor.types.includes("mage") && this.actor.armor.ac !== actor5e.system.attributes.ac.value) {
                await actor5e.update({
                    "system.attributes.ac.override": this.actor.armor.ac
                });
            }

            // Update cast activities to have the spells shown in the spellbook
            for (const item of actor5e.items) {
                for (const castActivity of (item.system.activities ?? []).filter(a => a.type === "cast")) {

                    // We only display the spell in the spellbook if it's not already granted by the Spellcasting feature
                    const spellAlreadyInSpellcasting = castActivity.item.name !== this.actor.spellcastingFeature?.featureName && this.actor.spellcastingFeature?.spellInfo?.some(
                        spellGroup => Array.isArray(spellGroup.value) && spellGroup.value.some(s => s.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_") === castActivity._inferredSource.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_"))
                    );

                    if (!spellAlreadyInSpellcasting) {
                        await castActivity.update({"spell.spellbook": true});
                    }
                }
            }
        }

        if (!this.actor.importIssues.missingSpells.length) {
            delete this.actor.importIssues.missingSpells;
        }
        if (!this.actor.importIssues.obsoleteSpells.length) {
            delete this.actor.importIssues.obsoleteSpells;
        }
        if (!this.actor.importIssues.crNotFound) {
            delete this.actor.importIssues.crNotFound;
        }

        return {actor5e, importIssues: this.actor.importIssues};
    }
}
