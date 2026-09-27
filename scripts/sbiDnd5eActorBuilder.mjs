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

        let actor5e;
        try {
            actor5e = await actorClass.create(actorData, operation);
            if (!actor5e) {
                throw new Error("Actor creation did not return a created Actor.");
            }

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
                    const pendingSpellName = this.actor.pendingCastSpells.get(castActivity.id);

                    if (pendingSpellName) {
                        // D&D5e resolves Cast Activity source UUIDs synchronously during
                        // preparation. Embedded Items inside Compendium Actors cannot be
                        // resolved that way, so only link the placeholder for World Actors.
                        if (destination === "world") {
                            const placeholderSpell = actor5e.items.find(
                                actorItem => actorItem.type === "spell"
                                    && actorItem.name === pendingSpellName
                                    && !actorItem.getFlag("dnd5e", "cachedFor")
                            );

                            if (!placeholderSpell) {
                                throw new Error(`Unable to link missing spell placeholder "${pendingSpellName}" on imported Actor.`);
                            }

                            await castActivity.update({"spell.uuid": placeholderSpell.uuid});
                        }
                        continue;
                    }

                    // We only display the cached spell in the spellbook if it's not already
                    // granted by Spellcasting and isn't represented by a missing-spell placeholder.
                    const sourceSpell = castActivity.spell.uuid ? await fromUuid(castActivity.spell.uuid) : null;
                    const spellName = sourceSpell?.name ?? castActivity.name;
                    const normalizedSpellName = spellName?.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_");
                    const spellAlreadyInSpellcasting = castActivity.item.name !== this.actor.spellcastingFeature?.featureName && normalizedSpellName && this.actor.spellcastingFeature?.spellInfo?.some(
                        spellGroup => Array.isArray(spellGroup.value) && spellGroup.value.some(s => s.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, "_") === normalizedSpellName)
                    );

                    if (!pendingSpellName && !spellAlreadyInSpellcasting) {
                        await castActivity.update({"spell.spellbook": true});
                    }
                }
            }
        } catch (error) {
            const importError = error instanceof Error ? error : new Error(String(error));

            if (actor5e) {
                try {
                    await actorClass.deleteDocuments([actor5e.id], operation);
                } catch (rollbackError) {
                    const cleanupError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
                    throw new Error(
                        `Actor import failed while finalizing "${actor5e.name}", and the incomplete Actor could not be removed. `
                        + `An incomplete Actor may remain at ${actor5e.uuid}. `
                        + `Import error: ${importError.message} Rollback error: ${cleanupError.message}`,
                        {cause: importError}
                    );
                }

                throw new Error(
                    `Actor import failed while finalizing "${actor5e.name}". The incomplete Actor was removed. ${importError.message}`,
                    {cause: importError}
                );
            }

            throw importError;
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
