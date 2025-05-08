document.addEventListener('DOMContentLoaded', () => {
    const startMenu = document.getElementById('startMenu');
    
    const playerNameInput = document.getElementById('playerNameInput');
    const startMultiplayerBtn = document.getElementById('startMultiplayerBtn');
    const startSinglePlayerBtn = document.getElementById('startSinglePlayerBtn');
    const playAgainBtn = document.getElementById('playAgainBtn');

    let currentGameInstance = null;

    playerNameInput.value = localStorage.getItem('agarClonePlayerName') || '';
    const localMaxMass = localStorage.getItem('agarCloneLocalMaxMass') || 0;
    document.getElementById('localMaxMass').textContent = Math.round(parseFloat(localMaxMass));

    async function startGame(mode) {
        const playerName = playerNameInput.value.trim() || `Player${Math.floor(Math.random()*1000)}`;
        if (playerName.length > 15) {
            alert("Player name too long (max 15 characters).");
            return;
        }
        if (playerName.length < 1) {
            alert("Player name cannot be empty.");
            return;
        }
        localStorage.setItem('agarClonePlayerName', playerName);

        if (currentGameInstance) {
            currentGameInstance.stopGame();
            currentGameInstance = null;
        }
        
        currentGameInstance = new Game(mode);
        try {
            await currentGameInstance.init(playerName);
        } catch (error) {
            console.error("Critical Game Initialization Error:", error);
            alert(`Could not start the game: ${error.message}. Please check the console and try again.`);
            if (currentGameInstance) {
                 currentGameInstance.showStartMenu();
                 currentGameInstance = null;
            } else {
                document.getElementById('startMenu').style.display = 'flex';
                document.getElementById('gameArea').style.display = 'none';
                document.getElementById('gameOverScreen').style.display = 'none';
            }
        }
    }

    startMultiplayerBtn.addEventListener('click', () => startGame('multiplayer'));
    startSinglePlayerBtn.addEventListener('click', () => startGame('singleplayer'));
    
    playAgainBtn.addEventListener('click', () => {
        if (currentGameInstance) {
            currentGameInstance.showStartMenu();
            currentGameInstance = null;
        } else {
            document.getElementById('startMenu').style.display = 'flex';
            document.getElementById('gameArea').style.display = 'none';
            document.getElementById('gameOverScreen').style.display = 'none';
        }
        const updatedLocalMaxMass = localStorage.getItem('agarCloneLocalMaxMass') || 0;
        document.getElementById('localMaxMass').textContent = Math.round(parseFloat(updatedLocalMaxMass));
    });

    window.addEventListener('beforeunload', async () => {
        if (currentGameInstance && currentGameInstance.mode === 'multiplayer' && currentGameInstance.localPlayer && currentGameInstance.supabase) {
            console.log("Unloading game, local player:", currentGameInstance.localPlayer.id);
        }
    });
});