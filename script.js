let canvas, ctx;
let paused = false;
let rotationX = 0;
let rotationY = 0;
let lastMouseX = null;
let lastMouseY = null;
let mouseDown = false;
let speed = 1;
let particleCount = 500;
let particles = [];
let colorScheme = "rainbow";
let bgColor = "#000000";
let attractorType = "lorenz";
let sidebarOpen = false;
let showTrails = false;

let scale = 10;
let pinchStartDist = null;

let lastTouchX = null;
let lastTouchY = null;
let isSingleFinger = false;

const attractorParams = {
    lorenz: { sigma: 10, rho: 28, beta: 2.667 },
    rossler: { a: 0.2, b: 0.2, c: 5.7 },
    halvorsen: { a: 1.4 },
    aizawa: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 }
};

const prettyParameters = {
    lorenz: { sigma: 10, rho: 28, beta: 2.667 },
    rossler: { a: 0.2, b: 0.2, c: 5.7 },
    halvorsen: { a: 1.4 },
    aizawa: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 }
};

const paramRanges = {
    lorenz: {
        sigma: { min: 0, max: 50, step: 0.1 },
        rho: { min: 0, max: 50, step: 0.1 },
        beta: { min: 0, max: 10, step: 0.1 }
    },
    rossler: {
        a: { min: 0, max: 1, step: 0.01 },
        b: { min: 0, max: 1, step: 0.01 },
        c: { min: 0, max: 10, step: 0.1 }
    },
    halvorsen: {
        a: { min: 0, max: 5, step: 0.1 }
    },
    aizawa: {
        a: { min: 0, max: 2, step: 0.01 },
        b: { min: 0, max: 2, step: 0.01 },
        c: { min: 0, max: 2, step: 0.01 },
        d: { min: 0, max: 5, step: 0.1 },
        e: { min: 0, max: 1, step: 0.01 },
        f: { min: 0, max: 1, step: 0.01 }
    }
};

const initialRanges = {
    lorenz: {
        x: { min: -10, max: 10 },
        y: { min: -10, max: 10 },
        z: { min: 0, max: 30 }
    },
    rossler: {
        x: { min: -10, max: 10 },
        y: { min: -10, max: 10 },
        z: { min: 0, max: 10 }
    },
    halvorsen: {
        x: { min: -5, max: 5 },
        y: { min: -5, max: 5 },
        z: { min: -5, max: 5 }
    },
    aizawa: {
        x: { min: -2, max: 2 },
        y: { min: -2, max: 2 },
        z: { min: -2, max: 2 }
    }
};


const titleColors = {
    "rainbow": { attrac: "hsl(300, 100%, 60%)", tool: "hsl(180, 100%, 50%)" },
    "fire": { attrac: "hsl(20, 100%, 60%)", tool: "hsl(40, 100%, 50%)" },
    "cool": { attrac: "hsl(200, 50%, 70%)", tool: "hsl(160, 50%, 60%)" },
    "neon": { attrac: "hsl(300, 100%, 60%)", tool: "hsl(180, 100%, 50%)" },
    "pastel": { attrac: "hsl(300, 50%, 75%)", tool: "hsl(180, 50%, 75%)" },
    "grayscale": { attrac: "hsl(0, 0%, 70%)", tool: "hsl(0, 0%, 50%)" },
    "cyberpunk": { attrac: "hsl(300, 100%, 60%)", tool: "hsl(180, 100%, 50%)" }
};

window.onload = () => {
    canvas = document.getElementById('canvas');
    ctx = canvas.getContext('2d');
    resizeCanvas();

    initParticles();
    initUI();
    updateParametersUI();
    updateEquations();
    updateTitleColors();

    animate();
};

function initUI() {
    document.getElementById('trailToggleBtn').addEventListener('click', () => {
        showTrails = !showTrails;
        const trailBtn = document.getElementById('trailToggleBtn');
        trailBtn.textContent = `Trails: ${showTrails ? '💫' : '❌'}`;
    });
    document.getElementById('particleCount').addEventListener('input', e => {
        particleCount = parseInt(e.target.value);
        document.getElementById('particleCountVal').textContent = particleCount;
        initParticles();
    });
    document.getElementById('speed').addEventListener('input', e => {
        speed = parseFloat(e.target.value);
        document.getElementById('speedVal').textContent = speed + "x";
    });
    document.getElementById('colorScheme').addEventListener('change', e => {
        colorScheme = e.target.value;
        updateTitleColors();
    });

    document.getElementById('attractorType').addEventListener('change', e => {
        attractorType = e.target.value;
        setPredefinedParameters();
        updateParametersUI();
        resetParticles();
        updateEquations();
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
        setPredefinedParameters();
        updateParametersUI();
        resetParticles();
        updateEquations();
    });

    document.getElementById('pauseBtn').addEventListener('click', () => {
        paused = !paused;
        const pauseBtn = document.getElementById('pauseBtn');
        if (paused) {
            pauseBtn.innerHTML = '▶';
            pauseBtn.title = 'Resume Simulation';
        } else {
            pauseBtn.innerHTML = '⏸';
            pauseBtn.title = 'Pause Simulation';
        }
    });

    document.getElementById('helpBtn').addEventListener('click', () => {
        const helpOverlay = document.getElementById('helpOverlay');
        helpOverlay.style.display = (helpOverlay.style.display === 'none' ? 'block' : 'none');
    });

    document.getElementById('equationsBtn').addEventListener('click', () => {
        let eqOverlay = document.getElementById('equationsOverlay');
        updateEquations();
        eqOverlay.style.display = (eqOverlay.style.display === 'none' ? 'block' : 'none');
    });

    document.getElementById('randomizeBtn').addEventListener('click', randomizeParameters);

    window.addEventListener('keydown', handleKey);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mousemove', mouseMove);
    window.addEventListener('resize', resizeCanvas);

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        scale *= zoomFactor;
        scale = Math.max(1, Math.min(100, scale));
    }, { passive: false });

    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: true });

    const menuToggleBtn = document.getElementById('menuToggleBtn');
    const sidebar = document.querySelector('.sidebar');
    menuToggleBtn.addEventListener('click', () => {
        sidebarOpen = !sidebarOpen;
        if (sidebarOpen) {
            sidebar.classList.add('open');
        } else {
            sidebar.classList.remove('open');
        }
    });
}

function handleMouseDown(e) {
    mouseDown = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
}

function handleMouseUp() {
    mouseDown = false;
}

function handleTouchStart(e) {
    if (e.touches.length === 1) {
        // Single finger: rotate
        isSingleFinger = true;
        pinchStartDist = null;
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
        // Two fingers: pinch zoom
        isSingleFinger = false;
        pinchStartDist = getTouchDistance(e);
    }
}

function handleTouchMove(e) {
    if (e.touches.length === 2) {
        // Pinch zoom
        e.preventDefault();
        const currentDist = getTouchDistance(e);
        const zoomFactor = currentDist / pinchStartDist;
        scale *= zoomFactor;
        scale = Math.max(1, Math.min(100, scale));
        pinchStartDist = currentDist;
    } else if (e.touches.length === 1 && isSingleFinger) {
        // Single finger rotation
        e.preventDefault();
        const touchX = e.touches[0].clientX;
        const touchY = e.touches[0].clientY;
        let dx = touchX - lastTouchX;
        let dy = touchY - lastTouchY;
        rotationX += dy * 0.01;
        rotationY += dx * 0.01;
        lastTouchX = touchX;
        lastTouchY = touchY;
    }
}

function handleTouchEnd(e) {
    if (e.touches.length < 1) {
        isSingleFinger = false;
        pinchStartDist = null;
    }
}

function randomizeParameters() {
    const params = attractorParams[attractorType];
    const ranges = paramRanges[attractorType];
    for (let key in params) {
        if (ranges[key]) {
            let r = ranges[key];
            let randomVal = r.min + Math.random() * (r.max - r.min);
            params[key] = parseFloat(randomVal.toFixed(3));
        }
    }
    updateParametersUI();
    resetParticles();
}

function getTouchDistance(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function updateEquations() {
    let eqDiv = document.getElementById('equationsContent');
    let eqText = "";

    if (attractorType === 'lorenz') {
        eqText = `
        \\[
        \\frac{dx}{dt} = \\sigma(y - x)
        \\]
        \\[
        \\frac{dy}{dt} = x(\\rho - z) - y
        \\]
        \\[
        \\frac{dz}{dt} = xy - \\beta z
        \\]`;
    } else if (attractorType === 'rossler') {
        eqText = `
        \\[
        \\frac{dx}{dt} = -y - z
        \\]
        \\[
        \\frac{dy}{dt} = x + a y
        \\]
        \\[
        \\frac{dz}{dt} = b + z(x - c)
        \\]`;
    } else if (attractorType === 'halvorsen') {
        eqText = `
        \\[
        \\frac{dx}{dt} = -a x - 4 y - 4 z - y^2
        \\]
        \\[
        \\frac{dy}{dt} = -a y - 4 z - 4 x - z^2
        \\]
        \\[
        \\frac{dz}{dt} = -a z - 4 x - 4 y - x^2
        \\]`;
    } else if (attractorType === 'aizawa') {
        eqText = `
        \\[
        \\frac{dx}{dt} = (z - b)x - d y
        \\]
        \\[
        \\frac{dy}{dt} = d x + (z - b)y
        \\]
        \\[
        \\frac{dz}{dt} = c + a z - \\frac{z^3}{3} - (x^2 + y^2)(1 + e z) + f z x^3
        \\]`;
    }


    eqDiv.innerHTML = eqText;
    if (window.MathJax && window.MathJax.typeset) {
        MathJax.typeset();
    }
}

function setPredefinedParameters() {
    Object.assign(attractorParams[attractorType], prettyParameters[attractorType]);
    updateParametersUI();
}

function updateParametersUI() {
    const container = document.getElementById('paramContainer');
    container.innerHTML = "";
    const params = attractorParams[attractorType];
    const ranges = paramRanges[attractorType];

    // Check if the current attractor is Aizawa
    const isAizawa = attractorType === 'aizawa';

    // Apply 'two-columns' class if Aizawa is selected, else remove it
    if (isAizawa) {
        container.classList.add('two-columns');
    } else {
        container.classList.remove('two-columns');
    }

    for (let key in params) {
        let val = params[key];
        let rangeSpec = ranges[key];
        if (!rangeSpec) continue;

        let group = document.createElement('div');
        group.className = 'param-group';

        let labelRow = document.createElement('div');
        labelRow.className = 'label-row';

        let label = document.createElement('label');
        label.textContent = key;

        let span = document.createElement('span');
        span.id = key + "Val";
        span.textContent = val.toFixed(3);

        let input = document.createElement('input');
        input.type = 'range';
        input.id = key;
        input.min = rangeSpec.min;
        input.max = rangeSpec.max;
        input.step = rangeSpec.step;
        input.value = val;
        input.addEventListener('input', e => {
            const newVal = parseFloat(e.target.value);
            attractorParams[attractorType][key] = newVal;
            span.textContent = newVal.toFixed(3);
        });

        labelRow.appendChild(label);
        labelRow.appendChild(span);
        group.appendChild(labelRow);
        group.appendChild(input);
        container.appendChild(group);
    }
}

function handleKey(e) {
    let step = e.shiftKey ? 1.0 : 0.1;

    if (e.code === 'Escape') {
        const helpOverlay = document.getElementById('helpOverlay');
        const eqOverlay = document.getElementById('equationsOverlay');


        if (helpOverlay.style.display === 'block') {
            helpOverlay.style.display = 'none';
        }
        if (eqOverlay.style.display === 'block') {
            eqOverlay.style.display = 'none';
        }
    } else if (e.code === 'Space') {
        paused = !paused;
        const pauseBtn = document.getElementById('pauseBtn');
        pauseBtn.innerHTML = paused ? '▶' : '⏸';
        pauseBtn.title = paused ? 'Resume Simulation' : 'Pause Simulation';
    } else if (e.code === 'Enter') {
        setPredefinedParameters();
        updateParametersUI();
    } else if (e.code === 'ArrowUp') {
        rotationX -= 0.1;
    } else if (e.code === 'ArrowDown') {
        rotationX += 0.1;
    } else if (e.code === 'ArrowLeft') {
        rotationY -= 0.1;
    } else if (e.code === 'ArrowRight') {
        rotationY += 0.1;
    } else {
        let p = attractorParams[attractorType];
        if (!p) return;
        const keys = Object.keys(p);
        if (keys.length === 0) return;
        updateParametersUI();
    }
}

function mouseMove(e) {
    if (!mouseDown) return;
    let dx = e.clientX - lastMouseX;
    let dy = e.clientY - lastMouseY;
    rotationX += dy * 0.01;
    rotationY += dx * 0.01;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
}

function resizeCanvas() {
    const sidebar = document.querySelector('.sidebar');
    let sidebarWidth = window.innerWidth > 768 ? sidebar.offsetWidth : 0;
    canvas.width = window.innerWidth - sidebarWidth;
    canvas.height = (window.innerWidth <= 768) ? (window.innerHeight - 50) : window.innerHeight;
}

function initParticles() {
    particles = [];
    const ranges = initialRanges[attractorType];

    if (!ranges) {
        console.error(`No initial ranges defined for attractor type: ${attractorType}`);
        return;
    }

    for (let i = 0; i < particleCount; i++) {
        let hue = Math.random() * 360;
        let hueInc = 0.5 + Math.random();

        particles.push({
            x: Math.random() * (ranges.x.max - ranges.x.min) + ranges.x.min,
            y: Math.random() * (ranges.y.max - ranges.y.min) + ranges.y.min,
            z: Math.random() * (ranges.z.max - ranges.z.min) + ranges.z.min,
            hue: hue,
            hueInc: hueInc,
            history: []
        });
    }
}



function resetParticles() {
    initParticles();
}

function stepLorenz(p) {
    let { sigma, rho, beta } = attractorParams.lorenz;
    let dx = sigma * (p.y - p.x);
    let dy = p.x * (rho - p.z) - p.y;
    let dz = p.x * p.y - beta * p.z;
    p.x += dx * 0.01 * speed;
    p.y += dy * 0.01 * speed;
    p.z += dz * 0.01 * speed;
}

function stepRossler(p) {
    let { a, b, c } = attractorParams.rossler;
    let dx = -p.y - p.z;
    let dy = p.x + a * p.y;
    let dz = b + p.z * (p.x - c);
    p.x += dx * 0.01 * speed;
    p.y += dy * 0.01 * speed;
    p.z += dz * 0.01 * speed;
}

function stepHalvorsen(p) {
    const a = attractorParams.halvorsen.a;
    const dx = -a * p.x - 4 * p.y - 4 * p.z - p.y * p.y;
    const dy = -a * p.y - 4 * p.z - 4 * p.x - p.z * p.z;
    const dz = -a * p.z - 4 * p.x - 4 * p.y - p.x * p.x;
    p.x += dx * 0.005 * speed;
    p.y += dy * 0.005 * speed;
    p.z += dz * 0.005 * speed;
}


function stepAizawa(p) {
    let { a, b, c, d, e, f } = attractorParams.aizawa;
    let dt = 0.005;
    let dx = (p.z - b) * p.x - d * p.y;
    let dy = d * p.x + (p.z - b) * p.y;
    let dz = c + a * p.z - p.z ** 3 / 3 - (p.x ** 2 + p.y ** 2) * (1 + e * p.z) + f * p.z * p.x ** 3;
    p.x += dx * dt * speed;
    p.y += dy * dt * speed;
    p.z += dz * dt * speed;
}

function animate() {
    requestAnimationFrame(animate);

    ctx.fillStyle = hexToRGBA(bgColor, 0.1);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let centerX = canvas.width / 2;
    let centerY = canvas.height / 2;
    let scaleFactor = scale;

    if (!paused) {
        for (let p of particles) {
            switch (attractorType) {
                case 'lorenz': stepLorenz(p); break;
                case 'rossler': stepRossler(p); break;
                case 'halvorsen': stepHalvorsen(p); break;
                case 'aizawa': stepAizawa(p); break;
            }

            if (showTrails) {
                // Update history only if trails are enabled
                p.history.push({ x: p.x, y: p.y, z: p.z });
                if (p.history.length > 50) p.history.shift();
            }
        }
    }

    // compute attractor center of mass
    let cx = 0, cy = 0, cz = 0;
    for (let p of particles) {
        cx += p.x; cy += p.y; cz += p.z;
    }

    cx /= particles.length;
    cy /= particles.length;
    cz /= particles.length;

    for (let p of particles) {
        if (showTrails) {
            ctx.beginPath();
            for (let i = 0; i < p.history.length; i++) {
                let point = p.history[i];
                let { px, py } = projectToScreen(point.x, point.y, point.z, centerX, centerY, scaleFactor, cx, cy, cz);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.strokeStyle = getColor(p);
            ctx.lineWidth = 1;
            ctx.stroke();
        } else {
            let { px, py } = projectToScreen(p.x, p.y, p.z, centerX, centerY, scaleFactor, cx, cy, cz);
            ctx.fillStyle = getColor(p);
            ctx.fillRect(px, py, 2, 2);
        }
    }
}

function projectToScreen(x, y, z, centerX, centerY, scaleFactor, cx = 0, cy = 0, cz = 0) {
    // translate relative to center of mass
    x -= cx; y -= cy; z -= cz;

    let cosX = Math.cos(rotationX), sinX = Math.sin(rotationX);
    let cosY = Math.cos(rotationY), sinY = Math.sin(rotationY);

    let xz = x * cosY - z * sinY;
    let zz = z * cosY + x * sinY;
    let yz = y * cosX - zz * sinX;

    return { px: xz * scaleFactor + centerX, py: yz * scaleFactor + centerY };
}

function getColor(p) {
    p.hue += p.hueInc * speed;
    if (p.hue > 360) p.hue -= 360;
    let h = p.hue;

    switch (colorScheme) {
        case "rainbow":
            return `hsl(${h}, 100%, 50%)`;
        case "fire":
            return `hsl(${(h % 40) + 10}, 100%, 50%)`;
        case "cool":
            return `hsl(${(h % 60) + 160}, 50%, 60%)`;
        case "neon":
            return (Math.floor(h / 60) % 2 === 0)
                ? `hsl(300, 100%, 60%)`
                : `hsl(180, 100%, 50%)`;
        case "pastel":
            return `hsl(${h}, 50%, 80%)`;
        case "grayscale":
            let val = Math.floor((h / 360) * 255);
            return `rgb(${val}, ${val}, ${val})`;
        case "cyberpunk":
            return (Math.floor(h / 90) % 2 === 0)
                ? `hsl(300, 100%, 60%)`
                : `hsl(180, 100%, 50%)`;
        default:
            return `hsl(${h}, 100%, 50%)`;
    }
}

function updateTitleColors() {
    const attracEls = document.querySelectorAll('.highlight-attrac');
    const toolEls = document.querySelectorAll('.highlight-tool');
    let scheme = titleColors[colorScheme];
    if (!scheme) {
        scheme = { attrac: "hsl(300, 100%, 60%)", tool: "hsl(180, 100%, 50%)" };
    }
    attracEls.forEach(el => el.style.color = scheme.attrac);
    toolEls.forEach(el => el.style.color = scheme.tool);
}

function saveImage() {
    let link = document.createElement('a');
    link.download = 'attractool.png';
    link.href = canvas.toDataURL();
    link.click();
}

function hexToRGBA(hex, alpha) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
