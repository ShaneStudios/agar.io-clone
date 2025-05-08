const { Engine, Render, Runner, Composite, Events, World, Mouse, Body, Bodies, Vector, Common } = Matter;

class Cell {
    constructor(x, y, radius, color, engine, options = {}) {
        this.id = options.id || generateUniqueId('cell_');
        this.initialRadius = radius;
        this.mass = radiusToMass(radius);
        this.color = color;
        this.ownerId = options.ownerId || null;
        this.isBotCell = options.isBotCell || false;
        this.isVirus = options.isVirus || false;
        this.isFood = options.isFood || false;
        this.isEjectedMass = options.isEjectedMass || false;
        
        this.canMerge = false;
        this.mergeCooldownTimer = null;
        this.lastSplitTime = Date.now();
        this.creationTime = Date.now();

        let label = 'cell';
        let friction = GameConfig.CELL_FRICTION_AIR; // Default player friction
        let category = 0x0001; // Player category default
        let mask = 0xFFFF;     // Collide with everything by default
        let isStatic = false;

        if (this.isVirus) {
             label = 'virus';
             friction = 0.1;
             category = 0x0004;
             mask = 0x0001 | 0x0008; // Collide Player + Ejected Mass
             isStatic = true;
        } else if (this.isFood) {
             label = 'food';
             friction = 0.2;
             category = 0x0002;
             mask = 0x0001; // Only collide Player
             isStatic = true;
        } else if (this.isEjectedMass) {
             label = 'ejected_mass';
             friction = GameConfig.EJECTED_MASS_FRICTION_AIR;
             category = 0x0008;
             mask = 0x0001 | 0x0004; // Collide Player + Virus
        }

        const bodyOptions = {
            label: label,
            frictionAir: friction,
            friction: 0.1,
            restitution: 0.1,
            density: 0.001, 
            isSensor: false,
            isStatic: isStatic,
            collisionFilter: { category: category, mask: mask },
            render: {
                fillStyle: this.color,
                strokeStyle: shadeColor(this.color, -20),
                lineWidth: 2
            },
            ...options.bodyOptions
        };
        this.body = Bodies.circle(x, y, this.calculateMatterRadius(radius), bodyOptions); 
        this.body.cellInstance = this;
        Body.setMass(this.body, this.mass / 100);

        Composite.add(engine.world, this.body); 

        if (!this.isFood && !this.isVirus && !this.isEjectedMass) {
            this.setMergeCooldown();
        }
    }
    
    calculateMatterRadius(visualRadius) {
        return Math.max(1, visualRadius);
    }

    get radius() {
        return massToRadius(this.mass);
    }

    setMergeCooldown() {
        this.canMerge = false;
        if (this.mergeCooldownTimer) clearTimeout(this.mergeCooldownTimer);
        const cooldownDuration = GameConfig.MERGE_COOLDOWN_BASE + (this.mass * GameConfig.MERGE_COOLDOWN_PER_MASS_FACTOR);
        this.mergeCooldownTimer = setTimeout(() => {
            this.canMerge = true;
        }, cooldownDuration);
    }

    updateMass(newMass) {
        if (!this.body) return;
        if (newMass <= 0) newMass = radiusToMass(1);
        const oldRadius = this.body.circleRadius;
        this.mass = newMass;
        const newVisualRadius = this.radius;
        const newMatterRadius = this.calculateMatterRadius(newVisualRadius);

        if (Math.abs(newMatterRadius - oldRadius) > 0.1) {
            const scaleFactor = newMatterRadius / oldRadius;
            if (isFinite(scaleFactor) && scaleFactor > 0) {
                 Body.scale(this.body, scaleFactor, scaleFactor);
                 this.body.circleRadius = newMatterRadius; 
            } else {
                console.warn(`Invalid scale factor: ${scaleFactor} for cell ${this.id}. Radius: ${newMatterRadius}, Old: ${oldRadius}`);
            }
        }
        Body.setMass(this.body, this.mass / 100); 
    }

    destroy(engine) {
        if (this.mergeCooldownTimer) clearTimeout(this.mergeCooldownTimer);
        if (this.body) {
            if (window.gameInstance) {
                window.gameInstance.queueBodyRemoval(this.body);
            } else {
                 console.warn("Game instance not found during cell destroy, removing body directly (might cause errors).");
                 Composite.remove(engine.world, this.body, true); 
            }
            this.body.cellInstance = null;
            this.body = null;
        }
    }
}

class Player {
    constructor(id, name, color, engine, isLocal = false, isBot = false, isPythonBot = false) {
        this.id = id;
        this.name = name;
        this.color = color;
        this.cells = [];
        this.engine = engine;
        this.isLocal = isLocal;
        this.isBot = isBot;
        this.isPythonBot = isPythonBot;
        this.maxSizeAchieved = 0;
        this.totalMass = 0;
        this.target = { x: 0, y: 0 };
        this.lastUpdateTime = Date.now();
        this.lastSentStateTime = 0;

        if (this.isBot && !this.isPythonBot) {
            this.botState = 'wandering';
            this.botTargetEntity = null;
            this.botDecisionTimeout = null;
            this.makeBotDecision();
        }
    }

    addCell(x, y, radius, options = {}) {
        const cell = new Cell(x, y, radius, this.color, this.engine, {
            ownerId: this.id,
            isBotCell: this.isBot,
            ...options
        });
        this.cells.push(cell);
        this.updateTotalMass();
        return cell;
    }

    removeCell(cellInstance) {
        const index = this.cells.findIndex(c => c.id === cellInstance.id);
        if (index !== -1) {
            const [removedCell] = this.cells.splice(index, 1);
            removedCell.destroy(this.engine); 
            this.updateTotalMass();
        }
        if (this.cells.length === 0 && !this.isBot) {
            if (window.gameInstance) {
                window.gameInstance.handlePlayerDeath(this);
            }
        } else if (this.cells.length === 0 && this.isPythonBot && window.gameInstance) {
            window.gameInstance.notifyPythonBotEaten(this.id);
        }
    }

    updateTotalMass() {
        this.totalMass = this.cells.reduce((sum, cell) => sum + cell.mass, 0);
        if (this.totalMass > this.maxSizeAchieved) {
            this.maxSizeAchieved = this.totalMass;
        }
        if (this.isLocal && document.getElementById('currentMass')) {
            document.getElementById('currentMass').textContent = Math.round(this.totalMass);
        }
    }

    getCenterOfMass() {
        if (this.cells.length === 0) return { x: GameConfig.WORLD_WIDTH / 2, y: GameConfig.WORLD_HEIGHT / 2 };
        let weightedSumX = 0;
        let weightedSumY = 0;
        let currentTotalMass = 0;

        this.cells.forEach(cell => {
            if (cell.body && cell.body.position) {
                weightedSumX += cell.body.position.x * cell.mass;
                weightedSumY += cell.body.position.y * cell.mass;
                currentTotalMass += cell.mass;
            }
        });
        if (currentTotalMass === 0) return { x: GameConfig.WORLD_WIDTH / 2, y: GameConfig.WORLD_HEIGHT / 2 };
        return { x: weightedSumX / currentTotalMass, y: weightedSumY / currentTotalMass };
    }

    getBoundingBox() {
        if (this.cells.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0};
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.cells.forEach(cell => {
            if (cell.body && cell.body.position) {
                const r = cell.radius;
                minX = Math.min(minX, cell.body.position.x - r);
                minY = Math.min(minY, cell.body.position.y - r);
                maxX = Math.max(maxX, cell.body.position.x + r);
                maxY = Math.max(maxY, cell.body.position.y + r);
            }
        });
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }

    update(mouseWorldPos) {
        if (this.isBot && !this.isPythonBot) {
            this.updateBotAI();
        } else if (this.isLocal) {
            this.target = mouseWorldPos; 
        }

        this.cells.forEach(cell => {
            if (cell.body && cell.body.position && this.target) {
                 const directionVec = Vector.sub(this.target, cell.body.position);
                 const distance = Vector.magnitude(directionVec);
                 
                 // Don't move if very close to target to avoid jitter
                 if (distance < cell.radius * 0.1) { 
                     Body.setVelocity(cell.body, { x: 0, y: 0 });
                     return;
                 }

                 const direction = Vector.normalise(directionVec);
                 const speed = calculateSpeed(cell.radius); // Speed based on radius
                 const targetVelocity = Vector.mult(direction, speed);
                 
                 Body.setVelocity(cell.body, targetVelocity); 
            }
        });
        this.lastUpdateTime = Date.now();
    }

    split() {
        if (this.cells.length >= GameConfig.PLAYER_MAX_CELLS) return;

        const cellsToSplit = [...this.cells];
        cellsToSplit.forEach(cell => {
            if (!cell.body) return;
            if (cell.radius < GameConfig.PLAYER_MIN_RADIUS_SPLIT || cell.mass < radiusToMass(GameConfig.PLAYER_MIN_RADIUS_SPLIT) * 1.8) return;
            if (this.cells.length >= GameConfig.PLAYER_MAX_CELLS) return;

            const newMass = cell.mass / 2;
            cell.updateMass(newMass);
            cell.lastSplitTime = Date.now();
            cell.setMergeCooldown();

            const newRadius = massToRadius(newMass);
            const splitDirection = Vector.normalise(Vector.sub(this.target, cell.body.position));
            const splitAngle = Math.atan2(splitDirection.y, splitDirection.x);
            
            const offset = cell.radius + newRadius + 2;
            const newX = cell.body.position.x + Math.cos(splitAngle) * offset;
            const newY = cell.body.position.y + Math.sin(splitAngle) * offset;

            const newCell = this.addCell(newX, newY, newRadius);
            newCell.lastSplitTime = Date.now();
            newCell.setMergeCooldown();

            // Apply velocity impulse for splitting motion
            const impulseVelocity = Vector.mult(splitDirection, GameConfig.SPLIT_VELOCITY_IMPULSE); 
            
            if(newCell.body) Body.setVelocity(newCell.body, Vector.add(cell.body.velocity || {x:0,y:0}, impulseVelocity)); // Add impulse to current velocity
            // Apply recoil to original cell (optional)
            // if(cell.body) Body.setVelocity(cell.body, Vector.add(cell.body.velocity || {x:0,y:0}, Vector.neg(impulseVelocity))); 
        });
        this.updateTotalMass();
    }

    ejectMass(gameInstance) {
        let ejectedCount = 0;
        this.cells.forEach(cell => {
             if (!cell.body) return;
            if (ejectedCount >= 2 && this.cells.length > 1) return;
            if (cell.radius < GameConfig.PLAYER_MIN_RADIUS_EJECT || cell.mass < radiusToMass(GameConfig.PLAYER_MIN_RADIUS_EJECT) + radiusToMass(GameConfig.EJECTED_MASS_RADIUS)) return;

            const ejectedActualMass = radiusToMass(GameConfig.EJECTED_MASS_RADIUS);
            cell.updateMass(cell.mass - ejectedActualMass);

            const ejectDirection = Vector.normalise(Vector.sub(this.target, cell.body.position)); 
            const ejectAngle = Math.atan2(ejectDirection.y, ejectDirection.x);
            const ejectStartPos = {
                x: cell.body.position.x + Math.cos(ejectAngle) * (cell.radius + GameConfig.EJECTED_MASS_RADIUS + 2),
                y: cell.body.position.y + Math.sin(ejectAngle) * (cell.radius + GameConfig.EJECTED_MASS_RADIUS + 2)
            };

            const ejectedCell = gameInstance.createEjectedMass(ejectStartPos.x, ejectStartPos.y, this.color, null, this.id);

            const velocity = Vector.mult(ejectDirection, GameConfig.EJECTED_MASS_SPEED); 
            if(ejectedCell.body) Body.setVelocity(ejectedCell.body, velocity);
            
            // Recoil force (less direct than velocity change)
            if(cell.body) Body.applyForce(cell.body, cell.body.position, Vector.neg(Vector.mult(velocity, ejectedCell.mass / 15))); 
            ejectedCount++;
        });
        if (ejectedCount > 0) this.updateTotalMass();
    }

    makeBotDecision() {
        if (this.botDecisionTimeout) clearTimeout(this.botDecisionTimeout);
        if (this.cells.length === 0 || !window.gameInstance) {
            this.botState = 'idle';
            return;
        }

        const game = window.gameInstance;
        let nearestFood = null, nearestThreat = null, nearestPrey = null;
        let minFoodDist = Infinity, minThreatDist = Infinity, minPreyDist = Infinity;

        const myLargestCellRadius = this.cells.reduce((maxR, c) => Math.max(maxR, c.radius), 0);
        const myCoM = this.getCenterOfMass();

        [...game.food.values(), ...game.ejectedMass.values()].forEach(f => {
             if (!f.body || !f.body.position) return;
            if (f.isEjectedMass && f.ownerId === this.id && (Date.now() - f.creationTime < GameConfig.EJECT_SELF_COLLISION_COOLDOWN * 2)) return;

            const dist = getDistance(f.body.position, myCoM);
            if (dist < minFoodDist && myLargestCellRadius > f.radius) {
                minFoodDist = dist;
                nearestFood = f;
            }
        });

        game.players.forEach((otherPlayer) => {
            if (otherPlayer.id === this.id || otherPlayer.cells.length === 0) return;
            const otherCoM = otherPlayer.getCenterOfMass();
            const otherLargestCellRadius = otherPlayer.cells.reduce((maxR, c) => Math.max(maxR, c.radius), 0);
            const dist = getDistance(otherCoM, myCoM);

            if (otherLargestCellRadius > myLargestCellRadius * 1.15) {
                if (dist < minThreatDist) {
                    minThreatDist = dist;
                    nearestThreat = otherPlayer;
                }
            } else if (myLargestCellRadius > otherLargestCellRadius * 1.15) {
                if (dist < minPreyDist) {
                    minPreyDist = dist;
                    nearestPrey = otherPlayer;
                }
            }
        });
        
        game.viruses.forEach(virus => {
             if (!virus.body || !virus.body.position) return;
            if (myLargestCellRadius > virus.radius * 0.9) {
                 const dist = getDistance(virus.body.position, myCoM);
                 if (dist < minThreatDist && dist < myLargestCellRadius * 3) {
                    minThreatDist = dist;
                    nearestThreat = virus;
                 }
            }
        });

        if (nearestThreat && minThreatDist < myLargestCellRadius * 4) {
            this.botState = 'fleeing';
            this.botTargetEntity = nearestThreat;
        } else if (nearestPrey && minPreyDist < myLargestCellRadius * 8) {
            this.botState = 'hunting';
            this.botTargetEntity = nearestPrey;
        } else if (nearestFood) {
            this.botState = 'seeking_food';
            this.botTargetEntity = nearestFood;
        } else {
            this.botState = 'wandering';
            this.botTargetEntity = null;
            this.target = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 200);
        }
        
        this.botDecisionTimeout = setTimeout(() => this.makeBotDecision(), Math.random() * 1500 + 500);
    }

    updateBotAI() {
        if (this.cells.length === 0 || !this.botState || this.botState === 'idle') return;
        const myCoM = this.getCenterOfMass();
        const myLargestRadius = this.cells.reduce((maxR, c) => Math.max(maxR, c.radius), 0);

        if (this.botTargetEntity) {
            let targetPos;
            if (this.botTargetEntity instanceof Player) targetPos = this.botTargetEntity.getCenterOfMass();
            else if (this.botTargetEntity.body) targetPos = this.botTargetEntity.body.position;
            else {
                this.botState = 'wandering'; this.botTargetEntity = null; return;
            }

            if (this.botState === 'fleeing') {
                const fleeDirection = Vector.normalise(Vector.sub(myCoM, targetPos)); 
                this.target = Vector.add(myCoM, Vector.mult(fleeDirection, 300)); 
            } else {
                this.target = targetPos;
                if (this.botState === 'hunting' && this.botTargetEntity instanceof Player) {
                    const prey = this.botTargetEntity;
                    const preyLargestRadius = prey.cells.reduce((maxR, c) => Math.max(maxR, c.radius), 0);
                    const distToPrey = getDistance(myCoM, prey.getCenterOfMass());

                    if (myLargestRadius > preyLargestRadius * 1.5 && distToPrey < myLargestRadius * 3 && Math.random() < 0.02) {
                        this.split();
                    } else if (myLargestRadius > preyLargestRadius * 1.2 && distToPrey < myLargestRadius * 5 && Math.random() < 0.01 && window.gameInstance) {
                        this.ejectMass(window.gameInstance);
                    }
                }
            }
        } else if (this.botState === 'wandering' && (!this.target || getDistance(this.target, myCoM) < 50)) {
            this.target = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 200);
        }
        if (this.target) {
            this.target.x = clamp(this.target.x, 0, GameConfig.WORLD_WIDTH);
            this.target.y = clamp(this.target.y, 0, GameConfig.WORLD_HEIGHT);
        }
    }
    
    getAverageRadius() {
        if (this.cells.length === 0) return GameConfig.PLAYER_INITIAL_RADIUS / 2;
        return this.cells.reduce((sum, cell) => sum + cell.radius, 0) / this.cells.length;
    }

    toPlainObject() {
        return {
            id: this.id,
            name: this.name,
            color: this.color,
            maxSizeAchieved: this.maxSizeAchieved,
            totalMass: this.totalMass,
            isBot: this.isBot,
            isPythonBot: this.isPythonBot,
            cells: this.cells.map(cell => ({
                id: cell.id,
                x: cell.body?.position.x || 0,
                y: cell.body?.position.y || 0,
                mass: cell.mass,
            })),
            target: this.target,
            lastUpdateTime: this.lastUpdateTime,
        };
    }

    static fromPlainObject(obj, engine, gameInstance) {
        let player = gameInstance.players.get(obj.id);
        if (!player) {
            player = new Player(obj.id, obj.name, obj.color, engine, false, obj.isBot, obj.isPythonBot); 
            gameInstance.players.set(obj.id, player);
        } else {
            player.name = obj.name;
            player.color = obj.color;
            player.isPythonBot = obj.isPythonBot || false; 
            player.maxSizeAchieved = Math.max(player.maxSizeAchieved, obj.maxSizeAchieved || 0);
            player.totalMass = obj.totalMass || 0;
            player.target = obj.target || player.target;
            player.lastUpdateTime = obj.lastUpdateTime || player.lastUpdateTime;
        }
    
        const existingCellIds = new Set(player.cells.map(c => c.id));
        const incomingCellIds = new Set(obj.cells.map(cData => cData.id));
    
        player.cells.filter(cell => !incomingCellIds.has(cell.id)).forEach(cellToRemove => {
            player.removeCell(cellToRemove);
        });
    
        obj.cells.forEach(cellData => {
            let cell = player.cells.find(c => c.id === cellData.id);
            const cellRadius = massToRadius(cellData.mass);
            if (cell) {
                if (cell.body) {
                    const timeSinceLastUpdate = Date.now() - player.lastUpdateTime;
                    if (player.isLocal || player.isPythonBot) { 
                         Body.setPosition(cell.body, { x: cellData.x, y: cellData.y });
                    } else if (timeSinceLastUpdate < GameConfig.MULTIPLAYER_DEAD_RECKONING_THRESHOLD) { 
                        const predictedPos = Vector.add(cell.body.position, Vector.mult(Vector.sub(player.target, cell.body.position), 0.01 * (timeSinceLastUpdate/16)));
                        Body.setPosition(cell.body, {
                            x: cell.body.position.x + (predictedPos.x - cell.body.position.x) * 0.2,
                            y: cell.body.position.y + (predictedPos.y - cell.body.position.y) * 0.2
                        });
                    } else {
                        Body.setPosition(cell.body, { x: cellData.x, y: cellData.y });
                    }
                    // Update velocity for remote players for slightly smoother visuals even with interpolation
                    if (!player.isLocal && cell.body.velocity) {
                        const direction = Vector.normalise(Vector.sub(player.target, cell.body.position));
                        const speed = calculateSpeed(cell.radius);
                        const targetVelocity = Vector.mult(direction, speed);
                        Body.setVelocity(cell.body, Vector.lerp(cell.body.velocity, targetVelocity, 0.1)); // Lerp velocity too
                    }

                } else {
                    player.removeCell(cell);
                    cell = player.addCell(cellData.x, cellData.y, cellRadius, { id: cellData.id });
                }
                if (Math.abs(cell.mass - cellData.mass) > 1) {
                    cell.updateMass(cellData.mass);
                }
            } else {
                cell = player.addCell(cellData.x, cellData.y, cellRadius, { id: cellData.id });
            }
            if (cell && cell.body && cell.color !== player.color) {
                cell.color = player.color;
            }
        });
        return player;
    }
}