import { Player, type PlayerInput } from "hytopia";
import { World } from "hytopia";
import { Vector3 } from "hytopia";
import { InventoryManager } from "../Inventory/InventoryManager";
import mapData from '../assets/maps/map_test.json';
import { Entity } from "hytopia";
import type { LevelingSystem } from '../LevelingSystem';
import { FISH_CATALOG } from './FishCatalog';
import type { ItemRarity } from '../Inventory/Inventory';
import type { PlayerStateManager } from "../PlayerStateManager";
import { MessageManager } from "../MessageManager";
import { FishSpawnManager, type CaughtFish } from "./FishSpawnManager";
import type { GamePlayerEntity } from "../GamePlayerEntity";
import { ReelingMovementController, MovementPattern } from './ReelingMovementController';
import { LeaderboardManager } from "../LeaderboardManager";

export interface FishingState {
    isCasting: boolean;
    isReeling: boolean;
    isJigging: boolean;
    lastInputState: PlayerInput;
    castPower: number;
    isPlayerFishing: boolean;
    currentCatch: CaughtFish | null;
    reelingGame: ReelingState;
    fishVelocityY: number;
    fishDepth: number;
    fishingInterval: NodeJS.Timeout | null;
}

interface ReelingState {
    isReeling: boolean;
    fishPosition: number;
    barPosition: number;
    fishVelocity: number;
    progress: number;
    currentCatch: CaughtFish | null;

     // Add new properties
     time: number;
     amplitude: number;
     frequency: number;
     basePosition: number;
}

export class FishingMiniGame {
    public reelingGame: ReelingGame;
    public isPlayerFishing = false;
    private currentCatch: CaughtFish | null = null;

    private readonly MAX_POWER = 100;
    private readonly POWER_LOOP_SPEED = 2; // How fast the power increases
    private readonly PLAYER_EYE_HEIGHT = 1.6; // Assuming a default eye height

    private readonly GAME_DURATION = 5000; // 5 seconds instead of 3
    private readonly DEPTH_LEVELS = 3;     // Just 3 depths: shallow, middle, deep
    private readonly GRAVITY = 0.01;          // Reduced for gentler falling
    private readonly BOUNCE_FACTOR = 0.8;    // Keep bounce at 80%
    private readonly JIG_FORCE = -0.1;       // Smaller upward force for gentler nudges  
    private uiHeight: number = 300;
    
    constructor(
        private world: World,
        private inventoryManager: InventoryManager,
        private levelingSystem: LevelingSystem,
        private stateManager: PlayerStateManager,
        private messageManager: MessageManager,
        private fishSpawnManager: FishSpawnManager
    ) {
        this.reelingGame = new ReelingGame(this.levelingSystem, world, inventoryManager, stateManager, this.messageManager);
        this.fishSpawnManager = fishSpawnManager;
    }


    onCastStart(player: Player) {
        const state = this.stateManager.getState(player);
        if (!state) return; 
        console.log("state swimming", state.swimming.isSwimming);
        if (this.stateManager.getInventory(player)?.equippedFish) {
            console.log("Unequipping fish before casting");
            this.inventoryManager.unequipItem(player, 'fish');
        }
        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];    
        let gamePlayerEntity = playerEntity as GamePlayerEntity;
        if (gamePlayerEntity.isInOrOnWater(playerEntity)) { return }
        console.log("casting", state.fishing.isCasting);
        if (!state.fishing.isCasting) {  // Start the power loop
            this.transitionFishingState(player, 'idle', 'casting');
            state.fishing.isCasting = true;
            state.fishing.castPower = 0;
            
            playerEntity.startModelOneshotAnimations([ 'cast_back_lower' ]);
            playerEntity.startModelOneshotAnimations([ 'cast_back_upper' ]);
            /*
            player.ui.sendData({
                type: 'castingPowerUpdate',
                power: state.fishing.castPower
            });
            */
        } else {  // Stop at current power and cast
            state.fishing.isCasting = false;
            this.onCastEnd(player);
        }
    }

    onCastEnd(player: Player) {
        const state = this.stateManager.getState(player);
        if (!state) return;

        // Clear UI
        player.ui.sendData({
            type: 'castingPowerUpdate',
            power: null
        });

        // Get PlayerEntity for this player
        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0] as GamePlayerEntity;
        if (!playerEntity) return;
        const rod = playerEntity.getEquippedRod(player);
        if (!rod) return;

        state.fishing.isPlayerFishing = true;


        playerEntity.stopModelAnimations(['cast_back_lower']);
        playerEntity.stopModelAnimations(['cast_back_upper']);
        playerEntity.startModelOneshotAnimations([ 'cast_foward_lower' ]);
        playerEntity.startModelOneshotAnimations([ 'cast_foward_upper' ]);

        // Get forward direction and negate it to reverse direction
        const rotation = playerEntity.rotation;
        const forwardX = -(2.0 * (rotation.w * rotation.y + rotation.x * rotation.z));
        const forwardZ = -(1.0 - 2.0 * (rotation.x * rotation.x + rotation.y * rotation.y));

        const startPos = {
            x: playerEntity.position.x,
            y: playerEntity.position.y + this.PLAYER_EYE_HEIGHT,
            z: playerEntity.position.z
        };

        console.log("Start pos:", playerEntity.position);
        console.log("Cast power:", state.fishing.castPower);

        const maxDistance = rod.metadata?.rodStats?.maxDistance ?? 10;
        const distance = (state.fishing.castPower / 100) * maxDistance;

        // Check if landing position is in water
        const result = this.findFishingSpot(startPos, { x: forwardX, z: forwardZ }, distance);
        if (result.found && result.position) {
            const marker = new Entity({
                name: 'CastMarker',
                modelUri: 'models/npcs/mackerel.gltf',
                modelScale: 0.5
            });
            marker.spawn(this.world, {
                x: result.position.x + 0.5,
                y: result.position.y + 2.5,
                z: result.position.z + 0.5
            });
            // Add debug logs and make sure game starts
            setTimeout(() => {
                marker.despawn();
                this.startFishing(player, result.position!);
            }, 2000);
        } else {
            playerEntity.stopModelAnimations(['cast_foward_lower']);
            playerEntity.stopModelAnimations(['cast_foward_upper']);
            state.fishing.isPlayerFishing = false;
        }

    }

    private findFishingSpot(startPos: { x: number, y: number, z: number }, 
        forwardDir: { x: number, z: number }, 
        distance: number): { found: boolean, position?: { x: number, y: number, z: number } } {
        const landingPos = {
        x: startPos.x + forwardDir.x * distance,
        y: startPos.y,
        z: startPos.z + forwardDir.z * distance
        };

        console.log("Checking cast at landing spot:", landingPos);

        for (let y = landingPos.y; y > 0; y--) {
        const checkPos = {
        x: Math.floor(landingPos.x),
        y: Math.floor(y),
        z: Math.floor(landingPos.z)
        };

        const blockKey = `${checkPos.x},${checkPos.y},${checkPos.z}`;
        const blockTypeId = (mapData.blocks as Record<string, number>)[blockKey];

        // Skip if air block (undefined)
        if (!blockTypeId) continue;

        // Found water
        if (blockTypeId === 43 || blockTypeId === 42 || blockTypeId === 100) {
        console.log("Found fishable water at:", checkPos);
        return { found: true, position: checkPos };
        }

        // Hit any other solid block - invalid fishing spot
        console.log("Hit non-water block:", blockTypeId, "at position:", checkPos);
        return { found: false };
        }

        return { found: false };
    }


    private startFishing(player: Player, landingPos: { x: number, y: number, z: number }) {
        const state = this.stateManager.getState(player);
        if (!state) return;
        console.log("Starting fishing mini-game");
        state.fishing.isJigging = true;
        state.fishing.fishDepth = 1;  // Start in middle
        state.fishing.fishVelocityY = 0;  // Start with no velocity
        
        // Show the game UI with new instructions
        this.transitionFishingState(player, 'casting', 'jigging');  // Add here
        /*
        player.ui.sendData({
            type: 'startFishing',
            fishDepth: 0.5,  // Start in middle (1/2)
            message: 'Press SPACE to keep the fish from falling! Keep it in the middle zone!'
        });
        */

        setTimeout(() => {
            console.log("Fishing game complete");
            if (state.fishing.isJigging) {
                state.fishing.isJigging = false;
                this.tryToFish(player, landingPos);
            }
        }, this.GAME_DURATION);
    }

    // Handle Q/E key presses
    private CASTING_UPDATE_INTERVAL = 50; // Send updates every 50ms instead of every tick
    private lastCastingUpdate = 0;

    public onTick(player: Player | null) {
        if (!player) return;
        const state = this.stateManager.getState(player);
        if (!state) return;



        // Handle casting power
        if (state.fishing.isCasting) {
            state.fishing.castPower += this.POWER_LOOP_SPEED;
                // Throttle UI updates
                const now = Date.now();
                if (now - this.lastCastingUpdate >= this.CASTING_UPDATE_INTERVAL) {
                    player.ui.sendData({
                        type: 'castingPowerUpdate',
                        power: state.fishing.castPower
                    });
                    this.lastCastingUpdate = now;
                }
            
            // Reset to 0 after reaching or exceeding MAX_POWER
            if (state.fishing.castPower >= this.MAX_POWER) {
                state.fishing.castPower = 0;
            }
        
        }

        // Handle fish physics if player is fishing
        if (state.fishing.isJigging && player?.input) {
            this.updateFishPhysics(player);
        }
        // Add reeling game tick
        if (this.reelingGame) {
            this.reelingGame.onTick(player);
        }
    }

    private updateFishPhysics(player: Player) {
        const state = this.stateManager.getState(player);
        if (!state || !player.input) return;
    
        // Apply gravity
        state.fishing.fishVelocityY += this.GRAVITY;
        state.fishing.fishDepth += state.fishing.fishVelocityY;
    
        // Handle Q key jig
        if (player.input['q']) {
            state.fishing.fishVelocityY = this.JIG_FORCE;
            player.input['q'] = false;
        }
    
        // Bounce off boundaries
        if (state.fishing.fishDepth <= 0) {
            state.fishing.fishDepth = 0;
            state.fishing.fishVelocityY = Math.abs(state.fishing.fishVelocityY) * this.BOUNCE_FACTOR;
        } else if (state.fishing.fishDepth >= 2) {
            state.fishing.fishDepth = 2;
            state.fishing.fishVelocityY = -Math.abs(state.fishing.fishVelocityY) * this.BOUNCE_FACTOR;
        }
    
        // Update UI
        player.ui.sendData({
            type: 'startFishing',
            fishDepth: state.fishing.fishDepth * 1.25
        });
    }

    public updateUIHeight(height: number) {
        this.uiHeight = height;
    }

    // Add method to check if reeling is active
    isReeling(): boolean {
        return this.reelingGame.isReeling;
    }

    //Landing position is the block the cast algo found 
    private tryToFish(player: Player, landingPos: { x: number, y: number, z: number }) {
        const state = this.stateManager.getState(player);
        if (!state) return;

        // Always send fishingComplete to dismiss the jig UI
        this.transitionFishingState(player, 'jigging', 'reeling');  // Add here

       /*
        player?.ui.sendData({
            type: 'fishingComplete'
        });
        */

        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];
        playerEntity.stopModelAnimations(['cast_foward_lower']);
        playerEntity.stopModelAnimations(['cast_foward_upper']);

        //RUNNING SIMULATION
        this.fishSpawnManager.runFishSimulation(new Vector3(landingPos.x, landingPos.y, landingPos.z), player);
        state.fishing.currentCatch = this.fishSpawnManager.getFishAtLocation(new Vector3(landingPos.x, landingPos.y, landingPos.z), Date.now(), player);

        
        if (state.fishing.currentCatch) {
            // Start reeling game
            this.reelingGame.startReeling(player, state.fishing.currentCatch);
            state.fishing.isPlayerFishing = false;
        } else {
            state.fishing.isPlayerFishing = false;
        }
    }

    private async transitionFishingState(player: Player, from: string, to: string) {
        const state = this.stateManager.getState(player);
        if (!state) return;
        // Clear UI and chain the new state
        this.clearAllFishingUI(player).then(() => {
            switch(to) {
                case 'casting':
                    player.ui.sendData({
                        type: 'castingPowerUpdate',
                        power: state.fishing.castPower
                    });
                    break;
                case 'jigging':
                    player.ui.sendData({
                        type: 'startFishing',
                        fishDepth: 0.5,
                        message: 'Press SPACE to keep the fish from falling! Keep it in the middle zone!'
                    });
                    break;
                case 'reeling':
                    player.ui.sendData({
                        type: 'fishingComplete'
                    });
                    break;
            }
        });
    }

    private clearAllFishingUI(player: Player): Promise<void> {
        return new Promise(resolve => {
            player.ui.sendData({
                type: 'fishingComplete'     // Clear jigging UI
            });
            player.ui.sendData({
                type: 'hideReeling'         // Clear reeling UI
            });
            player.ui.sendData({
                type: 'castingPowerUpdate', // Clear casting UI
                power: null
            });
            
            // Give a tiny window for UI to clear
            setTimeout(resolve, 16);  // One frame at 60fps
        });
    }

    public abortFishing(player: Player) {
        const state = this.stateManager.getState(player);
        if (!state) return;
    
        // Reset all fishing state flags
        state.fishing.isCasting = false;
        state.fishing.isReeling = false;
        state.fishing.isJigging = false;
        state.fishing.isPlayerFishing = false;
        state.fishing.currentCatch = null;
    
        // Clear any fishing intervals
        if (state.fishing.fishingInterval) {
            clearInterval(state.fishing.fishingInterval);
            state.fishing.fishingInterval = null;
        }
    
        // Reset animations
        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];
        if (playerEntity) {
            playerEntity.stopModelAnimations(['cast_back_lower', 'cast_back_upper', 'cast_foward_lower', 'cast_foward_upper']);
            playerEntity.startModelLoopedAnimations(['idle']);
        }
    
        // Clear all fishing-related UI
        player.ui.sendData({
            type: 'fishingComplete'  // Clears jigging UI
        });
        player.ui.sendData({
            type: 'hideReeling'      // Clears reeling UI
        });
        player.ui.sendData({
            type: 'castingPowerUpdate',
            power: null              // Clears casting UI
        });
    }
}

class ReelingGame {
    public isReeling = false;
    private player: Player | null = null;
    private fishPosition = 0.5;
    private barPosition = 0.5;
    private fishVelocity = 0.005;  // Original fish movement speed
    private  BAR_SPEED = 0.015;  // Original bar speed
    private readonly BAR_WIDTH = 0.25;
    private progress = 25;
    private levelingSystem: LevelingSystem;
    private world: World;
    private inventoryManager: InventoryManager;
    private stateManager: PlayerStateManager;
    // Progress tracking
    private readonly PROGRESS_GAIN = 0.5;
    private readonly PROGRESS_LOSS = 0.3;
    private readonly MAX_PROGRESS = 100;
    private readonly MIN_PROGRESS = 0;
    private currentCatch: CaughtFish | null = null;
    private readonly BASE_FISH_SPEED = 0.005;
    private readonly VALUE_SPEED_MULTIPLIER = 0.00002; // Adjust this value to tune difficulty
    private messageManager: MessageManager;
    private movementController: ReelingMovementController;
    private pattern: MovementPattern = MovementPattern.DEFAULT;
    private time: number = 0;
    
    constructor(levelingSystem: LevelingSystem, world: World, inventoryManager: InventoryManager, stateManager: PlayerStateManager, messageManager: MessageManager) {
        this.levelingSystem = levelingSystem;
        this.world = world;
        this.inventoryManager = inventoryManager;
        this.stateManager = stateManager;
        this.messageManager = messageManager;
        this.movementController = new ReelingMovementController(stateManager);
    }

    startReeling(player: Player, fish: CaughtFish) {
        const state = this.stateManager.getState(player);
        if (!state) return;
        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0] as GamePlayerEntity;
        let rodCheck = playerEntity.getEquippedRod(player);
        if (!rodCheck) return;
   
        const fishVelocity = this.movementController.calculateInitialVelocity(fish, rodCheck, player);
        this.pattern = this.movementController.getMovementPattern(fish);
        this.time = 0;
        
        state.fishing.reelingGame = {
            isReeling: true,
            fishPosition: 0.5,
            barPosition: 0.75,
            fishVelocity: fishVelocity,
            progress: 38,
            currentCatch: fish,
            // Add new properties for sinusoidal movement
            time: 0,
            amplitude: 0.2 + (Math.random() * 0.2),  // Random between 0.2-0.4
            frequency: 0.05 + (Math.random() * 0.05), // Random between 0.05-0.1
            basePosition: 0.5  // Center point for oscillation
        };
        
        player.ui.sendData({
            type: 'startReeling'
        });
        this.movementController.resetState();
    }

    onTick(player: Player | null) {
        if (!player) return;

        const state = this.stateManager.getState(player);
        if (!state || !state.fishing.reelingGame.isReeling || !player.input) { return; }

        const game = state.fishing.reelingGame;
        
        this.time += 1;
        const movement = this.movementController.updateFishPosition(
            game.fishPosition,
            game.fishVelocity,
            this.pattern,
            this.time
        );
        
        game.fishPosition = movement.position;
        game.fishVelocity = movement.velocity;

        // Update bar position
        if (player.input['q']) {
            game.barPosition = Math.min(0.8, game.barPosition + this.BAR_SPEED);
        } else {
            game.barPosition = Math.max(0, game.barPosition - this.BAR_SPEED);
        }

        // Check if fish is in target zone
        const fishInZone = game.fishPosition >= game.barPosition && 
                          game.fishPosition <= (game.barPosition + this.BAR_WIDTH);

        // Update progress
        if (fishInZone) {
            game.progress = Math.min(this.MAX_PROGRESS, game.progress + this.PROGRESS_GAIN);
        } else {
            game.progress = Math.max(this.MIN_PROGRESS, game.progress - this.PROGRESS_LOSS);
        }
        
        // Check win/lose conditions
         if (game.progress >= this.MAX_PROGRESS && game.currentCatch) {
            this.handleSuccess(player, game.currentCatch);
        } else if (game.progress <= this.MIN_PROGRESS) {
            this.handleFailure(player);
        }

        // Send updates to UI
        player.ui.sendData({
            type: 'updateReeling',
            fishPosition: game.fishPosition,
            barPosition: game.barPosition,
            progress: game.progress
        });
    }

    private handleSuccess(player: Player, fish: CaughtFish) {
        const state = this.stateManager.getState(player);
        if (!state) return;

        state.fishing.reelingGame.isReeling = false;
        
        // Hide reeling UI
        player.ui.sendData({
            type: 'hideReeling'
        });

        console.log("Fish caught!");
        if (!state.fishing.reelingGame.currentCatch) return;
        const fishDetails = this.getFishDetails(state.fishing.reelingGame.currentCatch);
        if (fishDetails) {
            // Add to inventory through state manager
            this.stateManager.addInventoryItem(player, {
                id: fish.id,
                modelId: fishDetails.modelUri,
                sprite: fishDetails.sprite,
                type: 'fish',
                name: fish.name,
                rarity: fish.rarity as ItemRarity,
                value: fish.value,
                quantity: 1,
                metadata: {
                    fishStats: {
                        weight: fish.weight,
                        size: 0,
                        species: fish.name,
                        isBaitFish: fish.isBaitFish
                    }
                }
            });

            // Calculate and grant XP
            if (this.levelingSystem?.calculateFishXP) {
                const xpGained = this.levelingSystem.calculateFishXP({
                    ...fish,
                    rarity: fish.rarity.toLowerCase() as "common" | "uncommon" | "rare" | "epic" | "legendary",
                    minWeight: fishDetails.minWeight
                });
                console.log("XP gained: ", xpGained);
                this.levelingSystem.addXP(player, xpGained);
            }

            this.messageManager.sendGameMessage(`Caught a ${fish.rarity} ${fish.name} weighing ${fish.weight}lb!`, player);

            // Record the catch in the leaderboard
            this.recordCatchInLeaderboard(player, fish);

            const equippedRod = this.inventoryManager.getEquippedRod(player);
            console.log("Equipped rod: ", equippedRod);
            if (equippedRod) {
                const rodDamage = equippedRod.metadata?.rodStats?.damage ?? 1;
                this.stateManager.applyRodDamage(player, equippedRod.id, rodDamage);
            }

            // Update inventory UI
            player.ui.sendData({
                type: 'inventoryUpdate',
                inventory: this.inventoryManager.getInventory(player)
            });

            // Display the caught fish
            this.displayFish(player, fish);
        }
    }

    private handleFailure(player: Player) {
        const state = this.stateManager.getState(player);
        if (!state) return;

        state.fishing.reelingGame.isReeling = false;
        
        player.ui.sendData({
            type: 'hideReeling'
        });
        this.messageManager.sendGameMessage("The fish got away!", player);
            // Apply double rod damage on failure
        const equippedRod = this.inventoryManager.getEquippedRod(player);
        if (equippedRod) {
            const rodDamage = equippedRod.metadata?.rodStats?.damage ?? 1;
            this.stateManager.applyRodDamage(player, equippedRod.id, rodDamage);
        }
        // Update inventory UI to show the updated rod health
        player.ui.sendData({
            type: 'inventoryUpdate',
            inventory: this.inventoryManager.getInventory(player)
        });
    }

    private getFishDetails(caughtFish: CaughtFish) {
        // Look up the base fish data from catalog
        const fishData = FISH_CATALOG.find(f => f.name === caughtFish.name);
        if (!fishData) {
            console.error(`Could not find fish data for id: ${caughtFish.id}`);
            return null;
        }
    
        return {
            ...caughtFish,
            modelUri: fishData.modelData.modelUri,
            sprite: fishData.modelData.sprite,
            modelScale: fishData.modelData.baseScale,
            minWeight: fishData.minWeight
            // Add any other static properties we need from the catalog
        };
    }
    
    private displayFish(player: Player, fish: CaughtFish) {
        const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];
        
        // Remove existing display fish
        const existingDisplays = this.world.entityManager.getAllEntities().filter(
            entity => entity.name === 'displayFish'
        );
        existingDisplays.forEach(entity => entity.despawn());

        // Get fish data from catalog
        const fishData = FISH_CATALOG.find(f => f.name === fish.name);
        if (!fishData) return;

        // Calculate display scale
        const weightRatio = (fish.weight - fishData.minWeight) / (fishData.maxWeight - fishData.minWeight);
        const scaleMultiplier = fishData.modelData.baseScale + 
            (weightRatio * (fishData.modelData.maxScale - fishData.modelData.baseScale));

        // Create display entity
        const displayEntity = new Entity({
            name: 'displayFish',
            modelUri: fishData.modelData.modelUri,
            modelScale: scaleMultiplier,
            modelLoopedAnimations: ['swim'],
            parent: playerEntity,
        });
        
        displayEntity.spawn(this.world, { x: 0, y: 2.2, z: 0 });
        displayEntity.setAngularVelocity({ x: 0, y: Math.PI / 1.5, z: 0 });

        // Rotate animation
        let startTime = Date.now();
        const duration = 3000;
        
        const rotateInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = elapsed / duration;
            
            if (progress >= 1) {
                clearInterval(rotateInterval);
                displayEntity.despawn();
                return;
            }
            displayEntity.rotation.y = progress * Math.PI * 2;
        }, 16);
    }

    // Add this new method to record catches in the leaderboard
    private async recordCatchInLeaderboard(player: Player, fish: CaughtFish) {
        try {
            // Get the LeaderboardManager instance
            const leaderboardManager = LeaderboardManager.instance;
            
            if (!leaderboardManager) {
                console.error('[LEADERBOARD] LeaderboardManager instance not available');
                return;
            }

            const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];
            
            // Record the catch
            const isRecord = await leaderboardManager.recordCatch(
                player,
                fish.name,  // species
                fish.weight,
                fish.value,
                playerEntity.position ? `${playerEntity.position.x.toFixed(1)}, ${playerEntity.position.y.toFixed(1)}, ${playerEntity.position.z.toFixed(1)}` : undefined
            );
            
            // If it's a record, notify the player
            if (isRecord) {
                this.messageManager.sendGameMessage(`New record! Your ${fish.name} is now on the leaderboard!`, player);
                
                // Send updated leaderboard to all players
                const allPlayers = this.world.entityManager.getAllPlayerEntities();
                for (const p of allPlayers) {
                    await leaderboardManager.sendLeaderboardToPlayer(p.player, fish.name);
                }
            }
        } catch (e) {
            console.error('[LEADERBOARD] Error recording catch:', e);
        }
    }
}