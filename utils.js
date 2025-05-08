function generateUniqueId(prefix = '') {
    return prefix + Math.random().toString(36).substring(2, 10) + Date.now().toString(36).slice(-5);
}

function getRandomColor() {
    return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
}

function getRandomPosition(worldWidth, worldHeight, padding = 0) {
    return {
        x: padding + Math.random() * (worldWidth - padding * 2),
        y: padding + Math.random() * (worldHeight - padding * 2)
    };
}

function massToRadius(mass) {
    if (mass <= 0) return 1;
    return Math.sqrt(mass / Math.PI);
}

function radiusToMass(radius) {
    if (radius <=0) return Math.PI;
    return Math.PI * radius * radius;
}

function shadeColor(color, percent) {
    if (!color || color.length < 7) color = '#808080';
    let R = parseInt(color.substring(1,3),16);
    let G = parseInt(color.substring(3,5),16);
    let B = parseInt(color.substring(5,7),16);
    R = parseInt(String(R * (100 + percent) / 100));
    G = parseInt(String(G * (100 + percent) / 100));
    B = parseInt(String(B * (100 + percent) / 100));
    R = Math.max(0, Math.min(255, R));
    G = Math.max(0, Math.min(255, G));
    B = Math.max(0, Math.min(255, B));
    const RR = R.toString(16).padStart(2, '0');
    const GG = G.toString(16).padStart(2, '0');
    const BB = B.toString(16).padStart(2, '0');
    return `#${RR}${GG}${BB}`;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getDistance(pos1, pos2) {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function calculateSpeed(mass) {
    // Speed decreases inversely with mass (or radius) - adjust factor for desired effect
    return GameConfig.CELL_BASE_SPEED / (1 + mass / GameConfig.CELL_SPEED_MASS_FACTOR);
}