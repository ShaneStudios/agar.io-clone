class Game {
    constructor(mode = 'singleplayer') {
        this.mode = mode;
        this.engine = Engine.create({ 
            gravity: { x: 0, y: 0 },
            timing: { timeScale: 1 },
        });
        this.world = this.engine.world; 

        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.runner = Runner.create(); 

        this.players = new Map();
        this.food = new Map();
        this.viruses = new Map();
        this.ejectedMass = new Map();
        this.bodiesToRemove = new Set(); // Queue for deferred removal

        this.localPlayer = null;
        this.mouseWorldPos = { x: 0, y: 0 };
        this.camera = {
            x: GameConfig.WORLD_WIDTH / 2,
            y: GameConfig.WORLD_HEIGHT / 2,
            zoom: 1,
            targetZoom: 1,
            targetX: GameConfig.WORLD_WIDTH / 2,
            targetY: GameConfig.WORLD_HEIGHT / 2,
        };

        this.supabase = null;
        if (this.mode === 'multiplayer' && SUPABASE_URL && SUPABASE_ANON_KEY) {
            try {
                this.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            } catch (e) {
                console.error("Failed to initialize Supabase client:", e);
                alert("Error connecting to multiplayer service. Supabase might be misconfigured.");
                this.mode = 'singleplayer';
            }
        }

        this.usePythonBots = false;
        this.pythonBotUpdateIntervalId = null;

        this.debugInfoElement = document.getElementById('debugInfo');
        this.leaderboardUpdateInterval = null;
        this.multiplayerUpdateInterval = null;
        this.staleDataCleanupInterval = null;
        this.objectSpawnInterval = null;

        this.gameRunning = false;

        window.gameInstance = this;
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    async init(playerName) {
        this.gameRunning = true;
        this.setupMatterEvents(); // Setup events including afterUpdate
        this.initControls();

        if (this.mode === 'multiplayer') {
            if (!this.supabase) {
                alert("Supabase client not initialized. Cannot start multiplayer.");
                this.showStartMenu();
                return;
            }
            try {
                await this.initMultiplayer(playerName);
                this.leaderboardUpdateInterval = setInterval(() => this.updateLeaderboard(), GameConfig.LEADERBOARD_UPDATE_INTERVAL);
                this.multiplayerUpdateInterval = setInterval(() => this.sendMultiplayerUpdate(), GameConfig.MULTIPLAYER_UPDATE_INTERVAL);
                this.staleDataCleanupInterval = setInterval(() => this.cleanupStaleData(), GameConfig.STALE_PLAYER_CLEANUP_INTERVAL);
                this.objectSpawnInterval = setInterval(() => this.attemptObjectSpawnsMP(), GameConfig.OBJECT_SPAWN_ATTEMPT_INTERVAL);
                await this.cleanupStaleData();
            } catch (error) {
                console.error("Multiplayer Initialization Error:", error);
                alert(`Failed to start multiplayer game: ${error.message}. Falling back to Single Player.`);
                this.mode = 'singleplayer';
                await this.initSinglePlayer(playerName);
                 this.leaderboardUpdateInterval = setInterval(() => this.updateLeaderboard(), GameConfig.LEADERBOARD_UPDATE_INTERVAL);
            }
        } else { 
            this.usePythonBots = await this.checkPythonBackend();
            await this.initSinglePlayer(playerName);
            this.leaderboardUpdateInterval = setInterval(() => this.updateLeaderboard(), GameConfig.LEADERBOARD_UPDATE_INTERVAL);
            if (this.usePythonBots) {
                this.pythonBotUpdateIntervalId = setInterval(() => this.fetchPythonBotsData(), GameConfig.PYTHON_BOT_UPDATE_INTERVAL);
            }
        }

        Runner.run(this.runner, this.engine);
        this.gameLoop();

        document.getElementById('gameArea').style.display = 'block';
        document.getElementById('startMenu').style.display = 'none';
        document.getElementById('gameOverScreen').style.display = 'none';
    }

    async checkPythonBackend() {
        if (!PYTHON_BACKEND_URL) return false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), PYTHON_BACKEND_TIMEOUT);
            const response = await fetch(`${PYTHON_BACKEND_URL}/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (response.ok) {
                console.log("Python backend is online.");
                return true;
            }
            console.warn("Python backend responded but not OK:", response.status);
            return false;
        } catch (error) {
            console.warn("Python backend check failed (timeout or network error), using JS bots:", error.message);
            return false;
        }
    }


    async initSinglePlayer(playerName) {
        const playerId = generateUniqueId('local_');
        this.localPlayer = new Player(playerId, playerName, getRandomColor(), this.engine, true, false);
        const startPos = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 200);
        this.localPlayer.addCell(startPos.x, startPos.y, GameConfig.PLAYER_INITIAL_RADIUS);
        this.players.set(playerId, this.localPlayer);

        if (this.usePythonBots && PYTHON_BACKEND_URL) {
            try {
                const resetResponse = await fetch(`${PYTHON_BACKEND_URL}/bots/reset?count=${GameConfig.BOT_COUNT}`, { method: 'POST' });
                if (!resetResponse.ok) throw new Error('Failed to reset Python bots');
                await this.fetchPythonBotsData(true); 
            } catch (error) {
                console.warn("Failed to initialize Python bots, falling back to JS bots:", error.message);
                this.usePythonBots = false; 
                this.initializeJsBots();
            }
        } else {
            this.initializeJsBots();
        }

        for (let i = 0; i < GameConfig.MAX_FOOD_PELLETS; i++) this.spawnFoodPellet(true);
        for (let i = 0; i < GameConfig.MAX_VIRUSES; i++) this.spawnVirus(true);
    }

    initializeJsBots() {
        for (let i = 0; i < GameConfig.BOT_COUNT; i++) {
            const botId = generateUniqueId('jsbot_');
            const botName = `JSBot ${i + 1}`;
            const bot = new Player(botId, botName, getRandomColor(), this.engine, false, true, false); 
            const botStartPos = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 200);
            bot.addCell(botStartPos.x, botStartPos.y, GameConfig.PLAYER_INITIAL_RADIUS * (0.8 + Math.random() * 0.4));
            this.players.set(botId, bot);
        }
    }

    async fetchPythonBotsData(isInitial = false) {
        if (!this.usePythonBots || !PYTHON_BACKEND_URL || !this.gameRunning) return;
        try {
            const response = await fetch(`${PYTHON_BACKEND_URL}/bots`);
            if (!response.ok) throw new Error(`Python backend fetch failed: ${response.status}`);
            const botsData = await response.json();

            const currentPythonBotIds = new Set();
            botsData.forEach(botData => {
                currentPythonBotIds.add(botData.id);
                Player.fromPlainObject(botData, this.engine, this); 
            });

            this.players.forEach(player => {
                if (player.isPythonBot && !currentPythonBotIds.has(player.id)) {
                    player.cells.forEach(c => player.removeCell(c)); 
                    this.players.delete(player.id); 
                }
            });

        } catch (error) {
            console.warn("Error fetching/updating Python bots, potentially switching to JS bots:", error.message);
        }
    }

    async notifyPythonBotEaten(botId) {
        if (!this.usePythonBots || !PYTHON_BACKEND_URL) return;
        try {
            await fetch(`${PYTHON_BACKEND_URL}/bots/eaten/${botId}`, { method: 'POST' });
        } catch (error) {
            console.warn(`Failed to notify backend of eaten bot ${botId}:`, error.message);
        }
    }


    async initMultiplayer(playerName) {
        const userId = (await this.supabase.auth.getUser())?.data?.user?.id; 
        const localPlayerId = userId || generateUniqueId('guest_');

        this.localPlayer = new Player(localPlayerId, playerName, getRandomColor(), this.engine, true, false);
        const startPos = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 200);
        this.localPlayer.addCell(startPos.x, startPos.y, GameConfig.PLAYER_INITIAL_RADIUS);
        this.players.set(localPlayerId, this.localPlayer);

        await this.sendInitialPlayerData();
        await this.fetchInitialMultiplayerState();
        this.subscribeToChanges();
    }

    async sendInitialPlayerData() {
        if (!this.localPlayer || !this.supabase) return;
        const playerData = this.localPlayer.toPlainObject();
        const payload = {
            id: this.localPlayer.id,
            name: this.localPlayer.name,
            color: this.localPlayer.color,
            max_size_achieved: this.localPlayer.maxSizeAchieved,
            cell_data: { cells: playerData.cells, target: playerData.target, totalMass: playerData.totalMass },
            last_seen: new Date().toISOString()
        };
        const { error } = await this.supabase.from('players').upsert(payload, { onConflict: 'id' });
        if (error) {
            console.error("Error sending initial player data:", error);
            throw new Error(`Supabase player upsert failed: ${error.message}`);
        }
    }

    setupMatterEvents() {
        Events.on(this.engine, 'collisionStart', (event) => {
            if (!this.gameRunning) return;
            event.pairs.forEach(pair => {
                const bodyA = pair.bodyA;
                const bodyB = pair.bodyB;
                
                if (bodyA.cellInstance) bodyA.cellInstance.collidingWith = bodyB.cellInstance;
                if (bodyB.cellInstance) bodyB.cellInstance.collidingWith = bodyA.cellInstance;

                this.handleCollision(bodyA.cellInstance, bodyB.cellInstance, pair);
            });
        });
         Events.on(this.engine, 'collisionEnd', (event) => { 
            if (!this.gameRunning) return;
            event.pairs.forEach(pair => {
                if (pair.bodyA.cellInstance) pair.bodyA.cellInstance.collidingWith = null;
                if (pair.bodyB.cellInstance) pair.bodyB.cellInstance.collidingWith = null;
            });
        });
        // Add the afterUpdate listener for deferred removal
        Events.on(this.engine, 'afterUpdate', () => {
            if (!this.gameRunning) return; // Ensure game is running
            if (this.bodiesToRemove.size > 0) {
                this.bodiesToRemove.forEach(body => {
                    // Check if body still exists and is part of the world before removing
                    if (body && body.world) { 
                       Composite.remove(this.engine.world, body, true);
                    }
                });
                this.bodiesToRemove.clear(); // Clear the queue
            }
        });
    }

    // New method to queue body removals safely
    queueBodyRemoval(body) {
        if (body) {
            this.bodiesToRemove.add(body);
        }
    }

    handleCollision(cellA, cellB, pair) {
        if (!cellA || !cellB) return;

        const order = (c) => c.isFood ? 0 : (c.isEjectedMass ? 1 : (c.isVirus ? 2 : 3));
        if (order(cellA) < order(cellB)) {[cellA, cellB] = [cellB, cellA];}

        const playerA = cellA.ownerId ? this.players.get(cellA.ownerId) : null;
        const playerB = cellB.ownerId ? this.players.get(cellB.ownerId) : null;

        try {
            if (playerA && !cellA.isVirus && (cellB.isFood || cellB.isEjectedMass)) {
                if (cellB.isEjectedMass && cellB.ownerId === playerA.id && (Date.now() - cellB.creationTime < GameConfig.EJECT_SELF_COLLISION_COOLDOWN)) {
                    return;
                }
                if (cellA.radius > cellB.radius * 0.8) {
                     this.handleEatFoodLike(playerA, cellA, cellB);
                }
            }
            else if (playerA && playerB && playerA.id !== playerB.id && !cellA.isVirus && !cellB.isVirus) {
                this.handlePlayerCellVsPlayerCell(playerA, cellA, playerB, cellB, pair);
            }
            else if (playerA && playerB && playerA.id === playerB.id && !cellA.isVirus && !cellB.isVirus && cellA.id !== cellB.id) {
                this.handleOwnCellCollision(playerA, cellA, cellB, pair);
            }
            else if (playerA && !cellA.isVirus && cellB.isVirus) {
                this.handlePlayerCellVsVirus(playerA, cellA, cellB, pair);
            }
        } catch (e) {
            console.error("Error during collision handling:", e, cellA, cellB);
        }
    }
    
    handleEatFoodLike(player, eatingPlayerCell, foodLikeCell) {
        if (!player || player.cells.length === 0 || !eatingPlayerCell || !eatingPlayerCell.body) return;

        eatingPlayerCell.updateMass(eatingPlayerCell.mass + foodLikeCell.mass);
        player.updateTotalMass();
        
        const foodLikeId = foodLikeCell.id;
        this.removeFoodLike(foodLikeCell); // This queues the body removal

        if (this.mode === 'multiplayer' && this.supabase) {
            this.supabase.from('game_objects').delete().eq('id', foodLikeId).then(({error}) => {
                if (error) console.error(`Error deleting consumed ${foodLikeCell.label} from DB:`, foodLikeId, error.message);
            });
        } else if (this.mode === 'singleplayer' && foodLikeCell.isFood) {
            this.spawnFoodPellet(true);
        }
    }

    handlePlayerCellVsPlayerCell(playerA, cellA, playerB, cellB, pair) {
        if (!cellA?.body?.position || !cellB?.body?.position) return; 
        
        const dist = getDistance(cellA.body.position, cellB.body.position);
        const radiusA = cellA.radius;
        const radiusB = cellB.radius;

        const canAEatB = radiusA > radiusB * 1.1 && dist < radiusA - radiusB * 0.5;
        const canBEatA = radiusB > radiusA * 1.1 && dist < radiusB - radiusA * 0.5;

        if (canAEatB) {
            cellA.updateMass(cellA.mass + cellB.mass);
            playerA.updateTotalMass();
            playerB.removeCell(cellB); // Queues cellB removal
        } else if (canBEatA) {
            cellB.updateMass(cellB.mass + cellA.mass);
            playerB.updateTotalMass();
            playerA.removeCell(cellA); // Queues cellA removal
        }
    }
    
    handleOwnCellCollision(player, cellA, cellB, pair) {
        if (!cellA.canMerge || !cellB.canMerge || player.cells.length <= 1) return;
        if (!cellA?.body?.position || !cellB?.body?.position) return;

        const dist = getDistance(cellA.body.position, cellB.body.position);
        const combinedRadius = cellA.radius + cellB.radius;
        
        if (dist < combinedRadius * 0.75) {
            const [smallerCell, largerCell] = cellA.mass < cellB.mass ? [cellA, cellB] : [cellB, cellA];
            
            largerCell.updateMass(largerCell.mass + smallerCell.mass);
            player.removeCell(smallerCell); // Queues smallerCell removal
            if(largerCell && largerCell.body) { 
                 largerCell.setMergeCooldown();
            }
            player.updateTotalMass();
        }
    }

    handlePlayerCellVsVirus(player, playerCell, virusCell, pair) {
        if (playerCell.radius < virusCell.radius * 0.9) return;
        if (!virusCell?.body?.position) return; 

        const numSplits = Math.min(GameConfig.PLAYER_MAX_CELLS - player.cells.length + 1,
                                   Math.min(7, Math.floor(playerCell.mass / radiusToMass(GameConfig.PLAYER_INITIAL_RADIUS / 2))));
        if (numSplits <= 1) return;

        const originalMass = playerCell.mass;
        const massPerSplit = originalMass / numSplits;
        const radiusPerSplit = massToRadius(massPerSplit);

        player.removeCell(playerCell); // Queues removal

        for (let i = 0; i < numSplits; i++) {
            if (!this.players.has(player.id)) break; 

            const angle = (i / numSplits) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
            const offset = virusCell.radius * 0.5 + radiusPerSplit;
            const newX = virusCell.body.position.x + Math.cos(angle) * offset;
            const newY = virusCell.body.position.y + Math.sin(angle) * offset;
            
            const newSplitCell = player.addCell(newX, newY, radiusPerSplit);
            newSplitCell.lastSplitTime = Date.now();
            newSplitCell.setMergeCooldown();

            const impulseMagnitude = GameConfig.SPLIT_IMPULSE_FACTOR * newSplitCell.mass * 2;
            const impulse = Vector.mult(Vector.normalise({x: Math.cos(angle), y: Math.sin(angle)}), impulseMagnitude); 
            if(newSplitCell.body) Body.applyForce(newSplitCell.body, newSplitCell.body.position, impulse);
        }
        if (this.players.has(player.id)) { 
             player.updateTotalMass();
        }

        const virusId = virusCell.id;
        this.removeFoodLike(virusCell); // Queues removal
        if (this.mode === 'multiplayer' && this.supabase) {
            this.supabase.from('game_objects').delete().eq('id', virusId).then(({error}) => {
                 if (error) console.error(`Error deleting consumed virus ${virusId} from DB:`, error.message);
            });
            this.attemptObjectSpawnsMP('virus');
        } else {
            this.spawnVirus(true);
        }
    }
    
    removeFoodLike(foodLikeCell) {
        if (!foodLikeCell || !foodLikeCell.id) return;
        const id = foodLikeCell.id;
        let mapToRemoveFrom = null;

        if (foodLikeCell.isFood && this.food.has(id)) mapToRemoveFrom = this.food;
        else if (foodLikeCell.isVirus && this.viruses.has(id)) mapToRemoveFrom = this.viruses;
        else if (foodLikeCell.isEjectedMass && this.ejectedMass.has(id)) mapToRemoveFrom = this.ejectedMass;
        
        if(mapToRemoveFrom) mapToRemoveFrom.delete(id);
        foodLikeCell.destroy(this.engine); // This now queues the removal
    }

    initControls() {
        const gameAreaElement = document.getElementById('gameArea');
        let mousePosition = {x: this.canvas.width / 2, y: this.canvas.height / 2}; 

        const updateMousePosition = (event) => {
             if(!this.gameRunning) return;
            const rect = this.canvas.getBoundingClientRect();
            mousePosition.x = event.clientX - rect.left;
            mousePosition.y = event.clientY - rect.top;
        };
        gameAreaElement.addEventListener('mousemove', updateMousePosition);
        gameAreaElement.addEventListener('touchmove', (e) => {
             if (e.touches.length > 0) {
                 e.preventDefault(); 
                 updateMousePosition(e.touches[0]);
             }
        }, { passive: false }); 
        gameAreaElement.addEventListener('touchstart', (e) => {
             if (e.touches.length > 0) {
                 e.preventDefault();
                 updateMousePosition(e.touches[0]);
             }
        }, { passive: false });

        Events.on(this.engine, 'beforeUpdate', () => { 
            if (!this.localPlayer || !this.gameRunning) return;
            if (this.localPlayer.cells.length === 0) return; 
            const playerCoM = this.localPlayer.getCenterOfMass();
            // Prevent mouseWorldPos calculation if camera zoom is zero or invalid
            if (this.camera.zoom <= 0) return; 
            this.mouseWorldPos.x = playerCoM.x + (mousePosition.x - this.canvas.width / 2) / this.camera.zoom;
            this.mouseWorldPos.y = playerCoM.y + (mousePosition.y - this.canvas.height / 2) / this.camera.zoom;
        });

        this.keydownListener = (e) => {
            if (!this.localPlayer || this.localPlayer.cells.length === 0 || !this.gameRunning) return;
            if (e.key.toLowerCase() === 'w') {
                this.localPlayer.split();
                if(this.mode === 'multiplayer') this.sendMultiplayerUpdate(true);
            }
            if (e.code === 'Space') {
                e.preventDefault();
                this.localPlayer.ejectMass(this);
                 if(this.mode === 'multiplayer') this.sendMultiplayerUpdate(true);
            }
        };
        window.addEventListener('keydown', this.keydownListener);
    }

    updateCamera() {
        let targetX, targetY, targetZoomVal;

        if (!this.localPlayer || this.localPlayer.cells.length === 0) {
            targetX = this.camera.targetX; 
            targetY = this.camera.targetY;
            targetX = GameConfig.WORLD_WIDTH / 2;
            targetY = GameConfig.WORLD_HEIGHT / 2;
            targetZoomVal = 0.5;
        } else {
            targetX = this.localPlayer.getCenterOfMass().x;
            targetY = this.localPlayer.getCenterOfMass().y;
            
            const bb = this.localPlayer.getBoundingBox();
            const viewDiameter = Math.max(bb.width, bb.height, GameConfig.CAMERA_ZOOM_BASE_VIEW / 2);
            // Ensure viewDiameter is positive before division
            targetZoomVal = Math.min(this.canvas.width / (viewDiameter > 0 ? viewDiameter + 100 : 100), this.canvas.height / (viewDiameter > 0 ? viewDiameter + 100 : 100));
        }
        
        this.camera.targetX = targetX;
        this.camera.targetY = targetY;
        this.camera.targetZoom = clamp(targetZoomVal, GameConfig.MAX_ZOOM_OUT, GameConfig.MIN_ZOOM_IN);

        this.camera.x += (this.camera.targetX - this.camera.x) * GameConfig.CAMERA_SMOOTHING;
        this.camera.y += (this.camera.targetY - this.camera.y) * GameConfig.CAMERA_SMOOTHING;
        this.camera.zoom += (this.camera.targetZoom - this.camera.zoom) * GameConfig.CAMERA_SMOOTHING * 0.5;
    }

    drawGrid() {
        const gridSize = 50;
        this.ctx.strokeStyle = "rgba(200, 200, 200, 0.08)";
        this.ctx.lineWidth = 1;

        const scaledGridSize = gridSize * this.camera.zoom;
        if (scaledGridSize < 4) return; 
        
        const screenOffsetX = (this.canvas.width / 2) - (this.camera.x * this.camera.zoom);
        const screenOffsetY = (this.canvas.height / 2) - (this.camera.y * this.camera.zoom);

        const startX = Math.floor(-screenOffsetX / scaledGridSize) * gridSize;
        const startY = Math.floor(-screenOffsetY / scaledGridSize) * gridSize;

        const linesX = Math.ceil(this.canvas.width / scaledGridSize) + 2; 
        const linesY = Math.ceil(this.canvas.height / scaledGridSize) + 2;

        this.ctx.beginPath(); 
        for (let i = -1; i <= linesX; i++) {
            const x = screenOffsetX + (startX + i * gridSize) * this.camera.zoom;
            this.ctx.moveTo(Math.round(x) + 0.5, 0); 
            this.ctx.lineTo(Math.round(x) + 0.5, this.canvas.height);
        }
        for (let i = -1; i <= linesY; i++) {
            const y = screenOffsetY + (startY + i * gridSize) * this.camera.zoom;
            this.ctx.moveTo(0, Math.round(y) + 0.5);
            this.ctx.lineTo(this.canvas.width, Math.round(y) + 0.5);
        }
        this.ctx.stroke();
    }
    
    drawWorldBorder() {
        this.ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        this.ctx.lineWidth = Math.max(2, 5 * this.camera.zoom);
        
        const screenWorldX = (0 - this.camera.x) * this.camera.zoom + this.canvas.width / 2;
        const screenWorldY = (0 - this.camera.y) * this.camera.zoom + this.canvas.height / 2;
        const screenWorldWidth = GameConfig.WORLD_WIDTH * this.camera.zoom;
        const screenWorldHeight = GameConfig.WORLD_HEIGHT * this.camera.zoom;

        this.ctx.strokeRect(screenWorldX, screenWorldY, screenWorldWidth, screenWorldHeight);
    }

    render() {
        this.ctx.fillStyle = '#1a1a1a';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.save();
        this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
        this.ctx.scale(this.camera.zoom, this.camera.zoom);
        this.ctx.translate(-this.camera.x, -this.camera.y);

        this.drawGrid();
        this.drawWorldBorder();

        const renderOrder = (entity) => {
            if (entity.isFood) return 0;
            if (entity.isEjectedMass) return 1;
            if (entity.isVirus) return 2;
            return 3;
        };

        const entitiesToRender = [];
        this.food.forEach(f => entitiesToRender.push(f));
        this.ejectedMass.forEach(e => entitiesToRender.push(e));
        this.viruses.forEach(v => entitiesToRender.push(v));
        this.players.forEach(p => p.cells.forEach(c => entitiesToRender.push(c)));

        entitiesToRender.sort((a, b) => renderOrder(a) - renderOrder(b));

        entitiesToRender.forEach(cell => {
            if (!cell.body || !cell.body.position) return;
            const screenX = (cell.body.position.x - this.camera.x) * this.camera.zoom + this.canvas.width / 2;
            const screenY = (cell.body.position.y - this.camera.y) * this.camera.zoom + this.canvas.height / 2;
            const screenRadius = cell.radius * this.camera.zoom;

            if (screenX + screenRadius < -10 || screenX - screenRadius > this.canvas.width + 10 ||
                screenY + screenRadius < -10 || screenY - screenRadius > this.canvas.height + 10) {
                return; // Basic view culling with buffer
            }

            this.ctx.beginPath();
            this.ctx.arc(cell.body.position.x, cell.body.position.y, cell.radius, 0, 2 * Math.PI);
            this.ctx.fillStyle = cell.color;
            this.ctx.fill();
            
            const borderColor = (cell.ownerId && !cell.canMerge && !cell.isFood && !cell.isVirus && !cell.isEjectedMass) ? shadeColor(cell.color, 30) : shadeColor(cell.color, -20);
            this.ctx.strokeStyle = borderColor;
            this.ctx.lineWidth = Math.max(0.5, cell.radius / 15); 
            this.ctx.stroke();

            if (cell.ownerId && !cell.isFood && !cell.isVirus && !cell.isEjectedMass && screenRadius > 8) { 
                const owner = this.players.get(cell.ownerId);
                if (owner && owner.name) {
                    this.ctx.fillStyle = 'white';
                    this.ctx.textAlign = 'center';
                    this.ctx.textBaseline = 'middle';
                    const baseFontSize = clamp(cell.radius / 2.5, 10, 24); 
                    const finalFontSize = clamp(baseFontSize * Math.sqrt(1 / this.camera.zoom), 8, 30); 
                    this.ctx.font = `bold ${finalFontSize.toFixed(0)}px Arial`;
                    this.ctx.shadowColor = 'black';
                    this.ctx.shadowBlur = 2; 
                    this.ctx.fillText(owner.name, cell.body.position.x, cell.body.position.y);
                    this.ctx.shadowBlur = 0;
                }
            }
        });
        this.ctx.restore();
    }

    gameLoop() {
        if (!this.gameRunning) return;

        try {
            if (this.localPlayer) {
                this.localPlayer.update(this.mouseWorldPos);
            }

            if (this.mode === 'singleplayer') {
                this.players.forEach(p => { 
                    if (p.isBot && p.cells.length > 0) {
                        if (!p.isPythonBot) p.update();
                    }
                });
                if (this.food.size < GameConfig.MAX_FOOD_PELLETS && Math.random() < 0.15) this.spawnFoodPellet(true);
                if (this.viruses.size < GameConfig.MAX_VIRUSES && Math.random() < 0.02) this.spawnVirus(true);
            }
            
            this.updateCamera();
            this.render();
            this.updateDebugInfo();
        } catch (error) {
            console.error("Error in game loop:", error);
            // Optionally stop the game or show an error message
            // this.stopGame(); 
            // alert("An error occurred in the game loop. Please check the console.");
        }

        requestAnimationFrame(() => this.gameLoop());
    }
    
    updateDebugInfo() {
        if (!this.debugInfoElement || !this.gameRunning) return;
        let text = `Mode: ${this.mode} ${(this.mode === 'singleplayer' && this.usePythonBots) ? '(Py)' : (this.mode === 'singleplayer' ? '(JS)' : '')}\n`;
        if (this.localPlayer) {
            text += `Player: ${this.localPlayer.name} (${this.localPlayer.cells.length}, ${Math.round(this.localPlayer.totalMass)})\n`;
            text += `Cam: X:${this.camera.x.toFixed(0)} Y:${this.camera.y.toFixed(0)} Z:${this.camera.zoom.toFixed(3)}\n`;
        }
        text += `Entities: P:${this.players.size} F:${this.food.size} V:${this.viruses.size} E:${this.ejectedMass.size}\n`;
        text += `Bodies: ${Composite.allBodies(this.world).length}`;
        this.debugInfoElement.innerText = text;
    }

    updateLeaderboard() {
        if (!this.gameRunning) return;
        const leaderboardList = document.getElementById('leaderboard-list');
        if (!leaderboardList) return;
        leaderboardList.innerHTML = '';
        const sortedPlayers = Array.from(this.players.values())
            .filter(p => p.cells.length > 0 && p.totalMass > 0)
            .sort((a, b) => b.totalMass - a.totalMass)
            .slice(0, 10);

        sortedPlayers.forEach(p => {
            const li = document.createElement('li');
            li.textContent = `${p.name}: ${Math.round(p.totalMass)}`;
            if (this.localPlayer && p.id === this.localPlayer.id) {
                li.classList.add('local-player-entry');
            }
            leaderboardList.appendChild(li);
        });
    }

    handlePlayerDeath(player) {
        if (!player) return;
        if (player.isLocal) {
            if (!this.gameRunning) return; 
            this.gameRunning = false; 

            let deathMessage = "You were eaten!";
            this.showGameOver(player.maxSizeAchieved, deathMessage); 
            if (this.mode === 'singleplayer') {
                localStorage.setItem('agarCloneLocalMaxMass', Math.max(parseFloat(localStorage.getItem('agarCloneLocalMaxMass') || 0), player.maxSizeAchieved));
            } else if (this.supabase) {
                this.supabase.from('players').update({ max_size_achieved: player.maxSizeAchieved }).eq('id', player.id)
                .then(({error}) => {
                    if (error) console.error("Error updating final player stats:", error.message);
                });
            }
            this.localPlayer = null; 
        } else {
             console.log(`${player.name} was eliminated.`);
        }
    }

    showGameOver(finalMass, message) {
        document.getElementById('finalMass').textContent = Math.round(finalMass);
        document.getElementById('gameOverMessage').textContent = message;
        document.getElementById('gameOverScreen').style.display = 'flex';
        document.getElementById('gameArea').style.display = 'none';
    }
    
    showStartMenu() {
        document.getElementById('startMenu').style.display = 'flex';
        document.getElementById('gameArea').style.display = 'none';
        document.getElementById('gameOverScreen').style.display = 'none';
        const localMaxMass = localStorage.getItem('agarCloneLocalMaxMass') || 0;
        document.getElementById('localMaxMass').textContent = Math.round(parseFloat(localMaxMass));
        this.stopGame(); 
    }

    stopGame() {
        if (!this.gameRunning && !this.engine) return; 

        this.gameRunning = false;
        if (this.runner) Runner.stop(this.runner);
        
        if (this.leaderboardUpdateInterval) clearInterval(this.leaderboardUpdateInterval);
        if (this.multiplayerUpdateInterval) clearInterval(this.multiplayerUpdateInterval);
        if (this.staleDataCleanupInterval) clearInterval(this.staleDataCleanupInterval);
        if (this.objectSpawnInterval) clearInterval(this.objectSpawnInterval);
        if (this.pythonBotUpdateIntervalId) clearInterval(this.pythonBotUpdateIntervalId);
        this.leaderboardUpdateInterval = null;
        this.multiplayerUpdateInterval = null;
        this.staleDataCleanupInterval = null;
        this.objectSpawnInterval = null;
        this.pythonBotUpdateIntervalId = null;

        if (this.supabaseRealtimeChannelPlayers) {
            this.supabase.removeChannel(this.supabaseRealtimeChannelPlayers).catch(e=>console.warn("Error unsub players", e));
            this.supabaseRealtimeChannelPlayers = null;
        }
        if (this.supabaseRealtimeChannelGameObjects) {
            this.supabase.removeChannel(this.supabaseRealtimeChannelGameObjects).catch(e=>console.warn("Error unsub objects", e));
            this.supabaseRealtimeChannelGameObjects = null;
        }

        // Process any remaining removals before clearing world
        if (this.bodiesToRemove?.size > 0) {
            this.bodiesToRemove.forEach(body => {
                 if (body && body.world) { 
                     Composite.remove(this.engine.world, body, true);
                 }
            });
            this.bodiesToRemove.clear();
        }


        if (this.engine) {
            World.clear(this.world, false);
            Engine.clear(this.engine);
        }
        
        this.players.forEach(p => p.cells.forEach(c => c.destroy(this.engine))); 
        this.players.clear();
        this.food.clear();
        this.viruses.clear();
        this.ejectedMass.clear();
        
        if(this.localPlayer) this.localPlayer = null;

        if (this.engine) Events.off(this.engine); 
        if(this.keydownListener) window.removeEventListener('keydown', this.keydownListener);

        window.gameInstance = null;
        console.log("Game stopped and cleaned up.");
    }

    async sendMultiplayerUpdate(force = false) {
        if (!this.gameRunning || !this.localPlayer || this.localPlayer.cells.length === 0 || !this.supabase) return;
        
        const now = Date.now();
        if (!force && (now - this.localPlayer.lastSentStateTime < GameConfig.MULTIPLAYER_UPDATE_INTERVAL - 10)) {
             return;
        }

        const playerData = this.localPlayer.toPlainObject();
        const payload = {
            name: this.localPlayer.name,
            color: this.localPlayer.color,
            max_size_achieved: this.localPlayer.maxSizeAchieved,
            cell_data: { cells: playerData.cells, target: playerData.target, totalMass: playerData.totalMass },
            last_seen: new Date().toISOString()
        };

        const { error } = await this.supabase.from('players')
            .update(payload)
            .eq('id', this.localPlayer.id);

        if (error) console.error("Error sending player update:", error.message);
        else this.localPlayer.lastSentStateTime = now;
    }

    async fetchInitialMultiplayerState() {
        if (!this.supabase || !this.localPlayer) return;
        const { data: playersData, error: playersError } = await this.supabase.from('players').select('*').neq('id', this.localPlayer.id);
        if (playersError) {
            console.error("Error fetching initial players:", playersError.message);
            throw new Error(`Supabase fetch players failed: ${playersError.message}`);
        }
        if (playersData) {
            playersData.forEach(pData => {
                if (!pData.cell_data) { console.warn("Player data missing cell_data:", pData.id); return; }
                 Player.fromPlainObject(pData, this.engine, this);
            });
        }

        const { data: objectsData, error: objectsError } = await this.supabase.from('game_objects').select('*');
        if (objectsError) {
             console.error("Error fetching initial game objects:", objectsError.message);
             throw new Error(`Supabase fetch objects failed: ${objectsError.message}`);
        }
        if (objectsData) objectsData.forEach(objData => this.syncGameObjectFromDB(objData, 'INSERT'));
    }

    subscribeToChanges() {
        if (!this.supabase) return;

        const handlePlayerChange = (payload) => {
            if (!this.gameRunning) return;
            const { eventType, new: newRecord, old: oldRecord } = payload;
            const recordId = newRecord?.id || oldRecord?.id;
            if (!recordId || (this.localPlayer && recordId === this.localPlayer.id) ) return; 

            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                if (!newRecord.cell_data) { console.warn("Received player update missing cell_data:", recordId); return; }
                Player.fromPlainObject(newRecord, this.engine, this); 
            } else if (eventType === 'DELETE') {
                const playerToRemove = this.players.get(recordId);
                if (playerToRemove) {
                    playerToRemove.cells.forEach(c => playerToRemove.removeCell(c));
                    this.players.delete(recordId);
                }
            }
        };

        const handleObjectChange = (payload) => {
             if (!this.gameRunning) return;
             const { eventType, new: newRecord, old: oldRecord } = payload;
             this.syncGameObjectFromDB(eventType === 'DELETE' ? oldRecord : newRecord, eventType);
        };

        this.supabaseRealtimeChannelPlayers = this.supabase
            .channel('public:players-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, handlePlayerChange)
            .subscribe((status, err) => {
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error('Supabase players channel error/timeout:', err);
                else if (status === 'SUBSCRIBED') console.log('Realtime subscribed to players');
            });

        this.supabaseRealtimeChannelGameObjects = this.supabase
            .channel('public:game_objects-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'game_objects' }, handleObjectChange)
            .subscribe((status, err) => {
                 if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error('Supabase game_objects channel error/timeout:', err);
                 else if (status === 'SUBSCRIBED') console.log('Realtime subscribed to game_objects');
            });
    }

    syncGameObjectFromDB(objData, eventType) {
        if (!objData || !objData.id) return;
        const id = objData.id;

        const mapForType = (type) => {
            if (type === 'food') return this.food;
            if (type === 'virus') return this.viruses;
            if (type === 'ejected_mass') return this.ejectedMass;
            return null;
        };
        
        const objectMap = mapForType(objData.type);
        if (!objectMap) { console.warn("Unknown game object type from DB:", objData.type); return; }

        if (eventType === 'DELETE') {
            const existingObject = objectMap.get(id);
            if (existingObject) this.removeFoodLike(existingObject);
            return;
        }
        
        let existing = objectMap.get(id);

        if (existing) {
            if (existing.body) {
                 Body.setPosition(existing.body, {x: objData.x, y: objData.y});
                 if (existing.color !== objData.color) {
                    existing.color = objData.color;
                 }
            }
        } else {
            if(objectMap.has(id)) return; 

            if (objData.type === 'food') this.createFoodPellet(objData.x, objData.y, objData.color, objData.id);
            else if (objData.type === 'virus') this.createVirus(objData.x, objData.y, objData.color, objData.id);
            else if (objData.type === 'ejected_mass') {
                this.createEjectedMass(objData.x, objData.y, objData.color, objData.id, objData.owner_id || null);
            }
        }
    }

    async cleanupStaleData() {
        if (this.mode !== 'multiplayer' || !this.supabase) return;
        const staleTime = new Date(Date.now() - GameConfig.STALE_PLAYER_THRESHOLD).toISOString();
        const { error: deletePlayersError } = await this.supabase.from('players').delete().lt('last_seen', staleTime);
        if (deletePlayersError) console.error("Error cleaning stale players:", deletePlayersError.message);
        
        const staleObjectTime = new Date(Date.now() - GameConfig.EJECTED_MASS_LIFESPAN * 3).toISOString(); 
        const { error: deleteObjectsError } = await this.supabase.from('game_objects')
            .delete().lt('created_at', staleObjectTime).in('type', ['ejected_mass', 'food']);
        if (deleteObjectsError) console.error("Error cleaning stale game objects:", deleteObjectsError.message);
    }

    attemptObjectSpawnsMP(specificType = null) {
        if (this.mode !== 'multiplayer' || !this.supabase || !this.localPlayer) return;

        if (specificType === 'food' || (!specificType && Math.random() < 0.3)) {
            if (this.food.size + this.ejectedMass.size < GameConfig.MAX_FOOD_PELLETS * 1.5) this.spawnFoodPellet(false);
        }
        if (specificType === 'virus' || (!specificType && Math.random() < 0.05)) {
             if (this.viruses.size < GameConfig.MAX_VIRUSES) this.spawnVirus(false);
        }
    }

    createFoodPellet(x, y, color, id = null) {
        const foodId = id || generateUniqueId('food_');
        if (this.food.has(foodId)) return this.food.get(foodId);
        const food = new Cell(x, y, GameConfig.FOOD_RADIUS, color || getRandomColor(), this.engine, {
            id: foodId, isFood: true,
            bodyOptions: { isStatic: true, collisionFilter: { category: 0x0002, mask: 0x0001 } }
        });
        this.food.set(foodId, food);
        return food;
    }
    
    spawnFoodPellet(isLocalOnly = false) {
        const pos = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 50);
        const foodColor = getRandomColor();
        const foodId = generateUniqueId('food_');

        if (!isLocalOnly && this.mode === 'multiplayer' && this.supabase) {
            this.supabase.from('game_objects').insert({
                id: foodId, type: 'food', x: pos.x, y: pos.y,
                radius: GameConfig.FOOD_RADIUS, color: foodColor, created_at: new Date().toISOString()
            }).then(({error}) => {
                if (error && error.code !== '23505') {
                     console.error("Error inserting food to DB:", error.message);
                }
            });
        } else if (isLocalOnly) {
            this.createFoodPellet(pos.x, pos.y, foodColor, foodId);
        }
    }

    createVirus(x, y, color, id = null) {
        const virusId = id || generateUniqueId('virus_');
        if (this.viruses.has(virusId)) return this.viruses.get(virusId);
        const virus = new Cell(x, y, GameConfig.VIRUS_RADIUS, color || '#33dd33', this.engine, {
            id: virusId, isVirus: true,
            bodyOptions: { isStatic: true, collisionFilter: { category: 0x0004, mask: 0x0001 | 0x0008 } } 
        });
        this.viruses.set(virusId, virus);
        return virus;
    }
    spawnVirus(isLocalOnly = false) {
        const pos = getRandomPosition(GameConfig.WORLD_WIDTH, GameConfig.WORLD_HEIGHT, 100);
        const virusColor = '#33dd33';
        const virusId = generateUniqueId('virus_');
         if (!isLocalOnly && this.mode === 'multiplayer' && this.supabase) {
            this.supabase.from('game_objects').insert({
                id: virusId, type: 'virus', x: pos.x, y: pos.y,
                radius: GameConfig.VIRUS_RADIUS, color: virusColor, created_at: new Date().toISOString()
            }).then(({error}) => {
                if (error && error.code !== '23505') {
                    console.error("Error inserting virus to DB:", error.message);
                }
            });
        } else if (isLocalOnly) {
            this.createVirus(pos.x, pos.y, virusColor, virusId);
        }
    }

    createEjectedMass(x, y, color, id = null, ownerId = null) {
        const massId = id || generateUniqueId('eject_');
        if (this.ejectedMass.has(massId)) return this.ejectedMass.get(massId);
        const mass = new Cell(x, y, GameConfig.EJECTED_MASS_RADIUS, color, this.engine, {
            id: massId, isEjectedMass: true, ownerId: ownerId,
            bodyOptions: { 
                frictionAir: 0.02, 
                collisionFilter: { category: 0x0008, mask: 0x0001 | 0x0004 } 
            }
        });
        this.ejectedMass.set(massId, mass);
        
        if (this.mode === 'multiplayer' && this.supabase && !id) {
            this.supabase.from('game_objects').insert({
                id: mass.id, type: 'ejected_mass', x: mass.body.position.x, y: mass.body.position.y,
                radius: mass.radius, color: mass.color, created_at: new Date().toISOString(), owner_id: ownerId
            }).then(({error}) => {
                 if (error && error.code !== '23505') {
                    console.error("Error inserting ejected mass to DB:", error.message);
                    this.removeFoodLike(mass);
                 }
            });
        }
        
        setTimeout(() => {
            const existingMass = this.ejectedMass.get(massId);
            if (existingMass) { 
                this.removeFoodLike(existingMass);
                 if (this.mode === 'multiplayer' && this.supabase) {
                    this.supabase.from('game_objects').delete().eq('id', massId).then(({error}) => {
                        if(error) console.warn(`Failed to delete expired ejected mass ${massId} from DB: ${error.message}`);
                    });
                }
            }
        }, GameConfig.EJECTED_MASS_LIFESPAN);

        return mass;
    }
}