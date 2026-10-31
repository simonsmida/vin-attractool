"use strict";

/* ==========================================================================
   AttracTool: particle visualisation of chaotic attractors.

   Simulation
   - Each particle is integrated with classical RK4 on a bounded step size,
     driven by smoothed wall-clock time, so motion is identical at any
     refresh rate and does not change character with the speed slider.
   - A long reference orbit is computed for the current parameters. It frames
     the view and supplies points on the attractor, so particles start on the
     attractor and any particle that escapes is put back on it.
   - Every particle keeps a short history sampled at fixed simulation-time
     intervals (several per frame at high speed), so trails are true curves
     of the flow, not frame-to-frame jumps. The newest point is always the
     live position, so a trail never detaches from its particle.

   Rendering (WebGL 2, with a Canvas 2D fallback)
   - Positions live in a float texture; only the rows that changed are
     uploaded each frame. Trails are drawn as fine anti-aliased lines that
     fade with age, and particles as small soft dots, accumulated additively
     in a float buffer. A hue-preserving tone map keeps dense regions
     saturated instead of clipping them to white.
   ========================================================================== */

// --------------------------------------------------------------------------
// Attractor definitions
// --------------------------------------------------------------------------

/*
 * deriv(x, y, z, p, out) writes dx/dt, dy/dt, dz/dt into out[0..2].
 * h:         largest RK4 step (simulation time) that stays accurate.
 * timeScale: simulation time per real second at 1x speed.
 * up:        the attractor's natural "up" axis, shown vertically on screen.
 * view:      default [turn, tilt] in radians.
 * count:     particle count that renders the structure best.
 * presets:   curated settings for "Lucky". Each was checked numerically to
 *            stay bounded; "chaos" ones have a positive Lyapunov exponent.
 */
const ATTRACTORS = {
    lorenz: {
        name: "Lorenz",
        params: { sigma: 10, rho: 28, beta: 8 / 3 },
        // ρ is the main control: fixed points below 24.74, chaos above,
        // with periodic windows near 99.96 and beyond.
        ranges: {
            sigma: { min: 1, max: 30, step: 0.1 },
            rho: { min: 0.5, max: 100, step: 0.01 },
            beta: { min: 0.5, max: 6, step: 0.01 }
        },
        presets: [
            { name: "Classic butterfly", params: { sigma: 10, rho: 28, beta: 8 / 3 } },
            { name: "Wide wings", params: { sigma: 10, rho: 46, beta: 8 / 3 } },
            { name: "Fierce chaos", params: { sigma: 16, rho: 45.92, beta: 4 } },
            { name: "Slender lobes", params: { sigma: 10, rho: 28, beta: 1 } },
            { name: "Restless, σ = 14", params: { sigma: 14, rho: 28, beta: 8 / 3 } },
            { name: "Periodic knot, ρ = 99.96", params: { sigma: 10, rho: 99.96, beta: 8 / 3 } }
        ],
        meta: {
            sigma: { sym: "σ", name: "Prandtl number" },
            rho: { sym: "ρ", name: "Rayleigh number" },
            beta: { sym: "β", name: "Geometry factor" }
        },
        eq: [["ẋ", "{sigma}(y - x)"], ["ẏ", "x({rho} - z) - y"], ["ż", "xy - {beta}z"]],
        count: 4000,
        h: 0.006,
        timeScale: 0.55,
        up: [0, 0, 1],
        view: [-0.6, 0.18],
        seed: [1, 1, 20],
        deriv(x, y, z, p, out) {
            out[0] = p.sigma * (y - x);
            out[1] = x * (p.rho - z) - y;
            out[2] = x * y - p.beta * z;
        },
        tex: String.raw`\begin{aligned}
            \dot x &= \sigma\,(y - x)\\
            \dot y &= x\,(\rho - z) - y\\
            \dot z &= x y - \beta z
        \end{aligned}`
    },
    rossler: {
        name: "Rössler",
        params: { a: 0.2, b: 0.2, c: 5.7 },
        // c drives the period-doubling route to chaos; orbits escape for
        // a ≳ 0.39.
        ranges: {
            a: { min: 0.01, max: 0.38, step: 0.005 },
            b: { min: 0.01, max: 2, step: 0.01 },
            c: { min: 1, max: 18, step: 0.1 }
        },
        presets: [
            { name: "Classic band", params: { a: 0.2, b: 0.2, c: 5.7 } },
            { name: "Funnel", params: { a: 0.3, b: 0.2, c: 5.7 } },
            { name: "Large chaos, c = 14", params: { a: 0.1, b: 0.1, c: 14 } },
            { name: "Wide chaos, c = 18", params: { a: 0.1, b: 0.1, c: 18 } },
            { name: "Period-4 orbit", params: { a: 0.1, b: 0.1, c: 8.5 } },
            { name: "Period-2 orbit", params: { a: 0.1, b: 0.1, c: 6 } },
            { name: "Near the period-3 window", params: { a: 0.1, b: 0.1, c: 12 } }
        ],
        meta: {
            a: { sym: "a", name: "Spiral growth" },
            b: { sym: "b", name: "Vertical offset" },
            c: { sym: "c", name: "Fold threshold" }
        },
        eq: [["ẋ", "-y - z"], ["ẏ", "x + {a}y"], ["ż", "{b} + z(x - {c})"]],
        count: 3000,
        h: 0.025,
        timeScale: 2.4,
        up: [0, 0, 1],
        view: [-0.5, 0.42],
        seed: [1, 1, 0],
        deriv(x, y, z, p, out) {
            out[0] = -y - z;
            out[1] = x + p.a * y;
            out[2] = p.b + z * (x - p.c);
        },
        tex: String.raw`\begin{aligned}
            \dot x &= -y - z\\
            \dot y &= x + a y\\
            \dot z &= b + z\,(x - c)
        \end{aligned}`
    },
    halvorsen: {
        name: "Halvorsen",
        // Sprott's value. The often-quoted a = 1.89 settles onto a periodic
        // orbit (largest Lyapunov exponent ≈ 0); orbits escape for a < 1.25.
        params: { a: 1.27 },
        ranges: {
            a: { min: 1.25, max: 2.5, step: 0.01 }
        },
        presets: [
            { name: "Sprott's chaos, a = 1.27", params: { a: 1.27 } },
            { name: "Edge of chaos, a = 1.25", params: { a: 1.25 } },
            { name: "Calmer chaos, a = 1.4", params: { a: 1.4 } },
            { name: "Braided loop, a = 1.6", params: { a: 1.6 } },
            { name: "Periodic loop, a = 1.89", params: { a: 1.89 } }
        ],
        meta: {
            a: { sym: "a", name: "Damping" }
        },
        eq: [["ẋ", "-{a}x - 4y - 4z - y^2"], ["ẏ", "-{a}y - 4z - 4x - z^2"], ["ż", "-{a}z - 4x - 4y - x^2"]],
        count: 4000,
        h: 0.005,
        timeScale: 0.4,
        // Cyclic symmetry x → y → z → x; its axis is the diagonal.
        up: [-1, -1, -1],
        view: [0.3, 0.95],
        seed: [-1.48, -1.51, 2.04],
        deriv(x, y, z, p, out) {
            const a = p.a;
            out[0] = -a * x - 4 * y - 4 * z - y * y;
            out[1] = -a * y - 4 * z - 4 * x - z * z;
            out[2] = -a * z - 4 * x - 4 * y - x * x;
        },
        tex: String.raw`\begin{aligned}
            \dot x &= -a x - 4y - 4z - y^2\\
            \dot y &= -a y - 4z - 4x - z^2\\
            \dot z &= -a z - 4x - 4y - x^2
        \end{aligned}`
    },
    aizawa: {
        name: "Aizawa",
        params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 },
        ranges: {
            a: { min: 0, max: 2, step: 0.01 },
            b: { min: 0, max: 2, step: 0.01 },
            c: { min: 0, max: 2, step: 0.01 },
            d: { min: 0, max: 5, step: 0.05 },
            e: { min: 0, max: 1, step: 0.01 },
            f: { min: 0, max: 1, step: 0.01 }
        },
        presets: [
            { name: "Classic sphere", params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0.1 } },
            { name: "Wild sphere, e = 0.1", params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.1, f: 0.1 } },
            { name: "Smooth torus, f = 0", params: { a: 0.95, b: 0.7, c: 0.6, d: 3.5, e: 0.25, f: 0 } },
            { name: "Slow spin, d = 3", params: { a: 0.95, b: 0.7, c: 0.6, d: 3, e: 0.25, f: 0.1 } },
            { name: "Settled orbit, c = 0.65", params: { a: 0.95, b: 0.7, c: 0.65, d: 3.5, e: 0.25, f: 0.1 } }
        ],
        meta: {
            a: { sym: "a", name: "Axial growth" },
            b: { sym: "b", name: "Axial shift" },
            c: { sym: "c", name: "Axial offset" },
            d: { sym: "d", name: "Rotation rate" },
            e: { sym: "e", name: "Coupling" },
            f: { sym: "f", name: "Asymmetry" }
        },
        eq: [["ẋ", "(z - {b})x - {d}y"], ["ẏ", "{d}x + (z - {b})y"], ["ż", "{c} + {a}z - z^3/3"], ["", "- (x^2 + y^2)(1 + {e}z) + {f}zx^3"]],
        count: 5000,
        h: 0.012,
        timeScale: 0.8,
        up: [0, 0, 1],
        view: [0, 0.3],
        seed: [0.1, 0, 0],
        deriv(x, y, z, p, out) {
            const zb = z - p.b;
            const r2 = x * x + y * y;
            out[0] = zb * x - p.d * y;
            out[1] = p.d * x + zb * y;
            out[2] = p.c + p.a * z - (z * z * z) / 3 - r2 * (1 + p.e * z) + p.f * z * x * x * x;
        },
        tex: String.raw`\begin{aligned}
            \dot x &= (z - b)\,x - d\,y\\
            \dot y &= d\,x + (z - b)\,y\\
            \dot z &= c + a z - \tfrac{z^3}{3} - (x^2 + y^2)(1 + e z) + f z x^3
        \end{aligned}`
    },
    arneodo: {
        name: "Arneodo",
        // A "jerk" system: one cubic third-order equation x''' = f(x, x', x'').
        params: { a: 5.5, b: 3.5, c: 1 },
        ranges: {
            a: { min: 4.5, max: 6.2, step: 0.01 },
            b: { min: 3.2, max: 4.4, step: 0.01 },
            c: { min: 0.5, max: 2, step: 0.01 }
        },
        presets: [
            { name: "Classic", params: { a: 5.5, b: 3.5, c: 1 } },
            { name: "Wilder folds, b = 3.4", params: { a: 5.5, b: 3.4, c: 1 } },
            { name: "Compact, a = 4.8", params: { a: 4.8, b: 3.5, c: 1 } },
            { name: "Calmer, b = 3.8", params: { a: 5.5, b: 3.8, c: 1 } },
            { name: "Nearly periodic, a = 6", params: { a: 6, b: 3.5, c: 1 } }
        ],
        meta: {
            a: { sym: "a", name: "Linear gain" },
            b: { sym: "b", name: "Damping" },
            c: { sym: "c", name: "Cubic term" }
        },
        eq: [["ẋ", "y"], ["ẏ", "z"], ["ż", "{a}x - {b}y - z - {c}x^3"]],
        count: 4000,
        h: 0.012,
        timeScale: 1.7,
        up: [1, 0, 0],
        view: [0.5, 0.3],
        seed: [0.1, 0, 0],
        deriv(x, y, z, p, out) {
            out[0] = y;
            out[1] = z;
            out[2] = p.a * x - p.b * y - z - p.c * x * x * x;
        }
    },
    burke: {
        name: "Burke–Shaw",
        params: { s: 10, v: 4.272 },
        ranges: {
            s: { min: 7, max: 14, step: 0.01 },
            v: { min: 2.5, max: 7, step: 0.001 }
        },
        presets: [
            { name: "Classic", params: { s: 10, v: 4.272 } },
            { name: "Tall wings, s = 8", params: { s: 8, v: 4 } },
            { name: "Wild, v = 6", params: { s: 10, v: 6 } },
            { name: "Tight, s = 13", params: { s: 13, v: 5 } },
            { name: "Periodic orbit, v = 3", params: { s: 10, v: 3 } }
        ],
        meta: {
            s: { sym: "s", name: "Coupling" },
            v: { sym: "v", name: "Forcing" }
        },
        eq: [["ẋ", "-{s}(x + y)"], ["ẏ", "-y - {s}xz"], ["ż", "{s}xy + {v}"]],
        count: 3500,
        h: 0.004,
        timeScale: 0.5,
        up: [0, 0, 1],
        view: [0.8, 0.6],
        seed: [0.6, 0, 0],
        deriv(x, y, z, p, out) {
            out[0] = -p.s * (x + y);
            out[1] = -y - p.s * x * z;
            out[2] = p.s * x * y + p.v;
        }
    },
    chenlee: {
        name: "Chen–Lee",
        params: { a: 5, b: 10, c: 0.38 },
        ranges: {
            a: { min: 3.5, max: 6.5, step: 0.01 },
            b: { min: 7, max: 13, step: 0.01 },
            c: { min: 0.2, max: 0.8, step: 0.005 }
        },
        presets: [
            { name: "Classic", params: { a: 5, b: 10, c: 0.38 } },
            { name: "Restless, b = 8", params: { a: 5, b: 8, c: 0.38 } },
            { name: "Deep core, c = 0.6", params: { a: 5, b: 10, c: 0.6 } },
            { name: "Slow growth, a = 4", params: { a: 4, b: 10, c: 0.38 } }
        ],
        meta: {
            a: { sym: "a", name: "Growth" },
            b: { sym: "b", name: "Damping of y" },
            c: { sym: "c", name: "Damping of z" }
        },
        eq: [["ẋ", "{a}x - yz"], ["ẏ", "-{b}y + xz"], ["ż", "-{c}z + xy/3"]],
        count: 4000,
        h: 0.005,
        timeScale: 0.9,
        up: [0, 0, 1],
        view: [-0.54, 0.3],
        seed: [1, 1, 1],
        deriv(x, y, z, p, out) {
            out[0] = p.a * x - y * z;
            out[1] = -p.b * y + x * z;
            out[2] = -p.c * z + x * y / 3;
        }
    },
    newton: {
        name: "Newton–Leipnik",
        short: "Newton–Leipnik",
        // Two coexisting strange attractors; particles stay on the one the
        // reference orbit finds from the seed.
        params: { a: 0.4, b: 0.175 },
        ranges: {
            a: { min: 0.3, max: 0.5, step: 0.001 },
            b: { min: 0.12, max: 0.22, step: 0.001 }
        },
        presets: [
            { name: "Classic", params: { a: 0.4, b: 0.175 } },
            { name: "Softer, b = 0.2", params: { a: 0.4, b: 0.2 } },
            { name: "Other wing, a = 0.45", params: { a: 0.45, b: 0.18 } },
            { name: "Periodic, a = 0.3", params: { a: 0.3, b: 0.16 } }
        ],
        meta: {
            a: { sym: "a", name: "Damping" },
            b: { sym: "b", name: "Feedback" }
        },
        eq: [["ẋ", "-{a}x + y + 10yz"], ["ẏ", "-x - 0.4y + 5xz"], ["ż", "{b}z - 5xy"]],
        count: 3500,
        h: 0.04,
        timeScale: 6,
        span: 600,
        up: [0, 1, 0],
        view: [0.3, 0.3],
        seed: [0.349, 0, -0.16],
        deriv(x, y, z, p, out) {
            out[0] = -p.a * x + y + 10 * y * z;
            out[1] = -x - 0.4 * y + 5 * x * z;
            out[2] = p.b * z - 5 * x * y;
        }
    },
    tsucs: {
        name: "Three-scroll",
        // TSUCS1, the three-scroll unified chaotic system.
        params: { a: 40, k: 55, f: 20, c: 1.833, d: 0.16, e: 0.65 },
        ranges: {
            a: { min: 36, max: 44, step: 0.1 },
            k: { min: 48, max: 58, step: 0.1 },
            f: { min: 17, max: 21, step: 0.05 },
            c: { min: 1.6, max: 2.1, step: 0.001 },
            d: { min: 0.12, max: 0.22, step: 0.001 },
            e: { min: 0.6, max: 0.72, step: 0.001 }
        },
        presets: [
            { name: "Classic", params: { a: 40, k: 55, f: 20, c: 1.833, d: 0.16, e: 0.65 } },
            { name: "Stormy, f = 18", params: { a: 40, k: 55, f: 18, c: 1.833, d: 0.16, e: 0.65 } },
            { name: "Restless, k = 50", params: { a: 40, k: 50, f: 20, c: 1.833, d: 0.16, e: 0.65 } },
            { name: "Leaning, d = 0.2", params: { a: 40, k: 55, f: 20, c: 1.833, d: 0.2, e: 0.65 } }
        ],
        meta: {
            a: { sym: "a", name: "Coupling" },
            k: { sym: "k", name: "Drive" },
            f: { sym: "f", name: "Self-feedback" },
            c: { sym: "c", name: "Vertical growth" },
            d: { sym: "d", name: "Cross term" },
            e: { sym: "e", name: "Quadratic damping" }
        },
        eq: [["ẋ", "{a}(y - x) + {d}xz"], ["ẏ", "{k}x + {f}y - xz"], ["ż", "{c}z + xy - {e}x^2"]],
        count: 4000,
        h: 0.0005,
        timeScale: 0.1,
        transient: 20,
        span: 40,
        up: [0, 0, 1],
        view: [-0.5, 0.25],
        seed: [0.1, 1, -0.1],
        deriv(x, y, z, p, out) {
            out[0] = p.a * (y - x) + p.d * x * z;
            out[1] = p.k * x + p.f * y - x * z;
            out[2] = p.c * z + x * y - p.e * x * x;
        }
    },
    anishchenko: {
        name: "Anishchenko–Astakhov",
        short: "Anishchenko",
        // An electronic oscillator with inertial non-linearity; I(x) is a
        // switch, so the flow is piecewise smooth.
        params: { mu: 1.2, eta: 0.5 },
        ranges: {
            mu: { min: 0.9, max: 1.6, step: 0.01 },
            eta: { min: 0.25, max: 0.7, step: 0.01 }
        },
        presets: [
            { name: "Classic", params: { mu: 1.2, eta: 0.5 } },
            { name: "Tighter, μ = 1", params: { mu: 1, eta: 0.5 } },
            { name: "Slow return, η = 0.3", params: { mu: 1.1, eta: 0.3 } },
            { name: "Broad fan, μ = 1.5", params: { mu: 1.5, eta: 0.3 } }
        ],
        meta: {
            mu: { sym: "μ", name: "Excitation" },
            eta: { sym: "η", name: "Inertia" }
        },
        eq: [["ẋ", "{mu}x + y - xz"], ["ẏ", "-x"], ["ż", "{eta}(I(x)x^2 - z)"]],
        note: "I(x) = 1 when x > 0, otherwise 0.",
        count: 3000,
        h: 0.03,
        timeScale: 3.6,
        span: 500,
        up: [0, 0, 1],
        view: [0.6, 0.3],
        seed: [1, 0, 0],
        deriv(x, y, z, p, out) {
            out[0] = p.mu * x + y - x * z;
            out[1] = -x;
            out[2] = p.eta * ((x > 0 ? x * x : 0) - z);
        }
    },
    finance: {
        name: "Finance",
        // Ma–Chen model: x interest rate, y investment demand, z price index.
        params: { a: 0.001, b: 0.2, c: 1.1 },
        ranges: {
            a: { min: 0, max: 0.12, step: 0.001 },
            b: { min: 0.1, max: 0.26, step: 0.001 },
            c: { min: 0.95, max: 1.25, step: 0.005 }
        },
        presets: [
            { name: "Classic", params: { a: 0.001, b: 0.2, c: 1.1 } },
            { name: "Cheap investment, b = 0.1", params: { a: 0.00001, b: 0.1, c: 1 } },
            { name: "Higher savings, a = 0.05", params: { a: 0.05, b: 0.15, c: 1.2 } },
            { name: "Prudent, a = 0.1", params: { a: 0.1, b: 0.2, c: 1 } }
        ],
        meta: {
            a: { sym: "a", name: "Saving rate" },
            b: { sym: "b", name: "Investment cost" },
            c: { sym: "c", name: "Demand elasticity" }
        },
        eq: [["ẋ", "(1/{b} - {a} + y)x + z"], ["ẏ", "-{b}y - x^2"], ["ż", "-x - {c}z"]],
        count: 3000,
        h: 0.05,
        timeScale: 6,
        span: 600,
        up: [0, 1, 0],
        view: [-0.6, 0.3],
        seed: [0.1, 0, 0],
        deriv(x, y, z, p, out) {
            out[0] = (1 / p.b - p.a + y) * x + z;
            out[1] = -p.b * y - x * x;
            out[2] = -x - p.c * z;
        }
    }

};

const PARAM_LABELS = { sigma: "σ", rho: "ρ", beta: "β" };

// --------------------------------------------------------------------------
// Colour schemes: gradients sampled into a lookup table.
// Colour encodes each particle's local speed along the flow.
// --------------------------------------------------------------------------

const PALETTE_SIZE = 32;

const SCHEMES = {
    // Slow particles take the first colour, fast ones the last.
    spectrum: { label: "Spectrum", accent: "#8fc8ff", stops: ["#ff5a6e", "#ff9b4a", "#ffe066", "#5fe3a1", "#4cc3ff", "#8f7bff", "#e07bff"] },
    aurora: { label: "Aurora", accent: "#6ff0c8", stops: ["#2b5cff", "#2fa8ff", "#3fe0d0", "#7dffb0", "#e9ffd6"] },
    ember: { label: "Ember", accent: "#ffb15e", stops: ["#9e1b2f", "#e2453c", "#ff8a3d", "#ffc860", "#fff1cf"] },
    orchid: { label: "Orchid", accent: "#f0a6ff", stops: ["#4b3bff", "#9b5cff", "#e46bff", "#ff8fc7", "#ffe1ee"] },
    moonlight: { label: "Moonlight", accent: "#cfe0ff", stops: ["#3e5a8a", "#7f9cc8", "#c3d4f0", "#f4f8ff"] }
};

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Returns PALETTE_SIZE colours as [r, g, b] in 0..255. */
function buildPalette(scheme) {
    const out = [];
    const { stops } = SCHEMES[scheme] || SCHEMES.spectrum;
    for (let i = 0; i < PALETTE_SIZE; i++) {
        const t = i / (PALETTE_SIZE - 1);
        const seg = t * (stops.length - 1);
        const k = Math.min(stops.length - 2, Math.floor(seg));
        const f = seg - k;
        const a = hexToRgb(stops[k]);
        const b = hexToRgb(stops[k + 1]);
        out.push(a.map((v, j) => Math.round(v + (b[j] - v) * f)));
    }
    return out;
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

const MAX_PARTICLES = 20000;
const HISTORY_BUDGET = 160000;        // particles × history length
const TRAIL_SECONDS = 0.9;            // real-time length of a trail at 1x

const state = {
    type: "lorenz",
    params: {},                       // live parameter values per attractor
    count: 4000,
    speed: 1,
    paused: false,
    trails: true,
    trailFade: 1,                     // eases toward trails ? 1 : 0
    spin: true,
    scheme: "spectrum",
    palette: buildPalette("spectrum"),
    sceneFade: 1,                     // dips to 0 while switching attractors
    pendingType: null,
    morph: null,                      // { from, to, t } while Lucky morphs
    lastPreset: {}
};
for (const key in ATTRACTORS) state.params[key] = { ...ATTRACTORS[key].params };

// Particles (structure of arrays).
const px = new Float64Array(MAX_PARTICLES);
const py = new Float64Array(MAX_PARTICLES);
const pz = new Float64Array(MAX_PARTICLES);
const pSpeed = new Float32Array(MAX_PARTICLES);
let count = 0;

/*
 * History ring. Slot s holds every particle's sample at one moment. Slots are
 * laid out as blocks of R rows × W texels (W*R ≥ count), which matches the
 * GPU texture exactly, so one slot uploads as one rectangle.
 */
const hist = {
    L: 0,                             // slots
    W: 1, R: 1, stride: 0,            // texels per row, rows per slot, W*R
    buf: null,                        // Float32Array(L * stride * 4)
    head: 0,                          // slot holding the live position
    clock: 0,                         // sim time since the last committed sample
    interval: 1,                      // sim time between samples
    dirtySlots: new Set(),
    fullDirty: true
};

// Reference orbit: samples on the attractor plus its framing.
const REF_SAMPLES = 4096;
const ref = {
    pts: new Float64Array(REF_SAMPLES * 3),
    n: 0,
    center: [0, 0, 0],
    radius: 1,
    escape: 1e3,
    speedLo: 0,
    speedHi: 1,
    status: "ok"                      // ok | diverges | fixed
};

// Camera.
const cam = {
    q: [1, 0, 0, 0],                  // orientation quaternion [w, x, y, z]
    pendA: 0, pendB: 0,               // drag rotation not yet applied
    velA: 0, velB: 0,                 // angular velocity (rad/s) about screen axes
    spinRate: 0,                      // current idle spin (rad/s)
    zoom: 1,
    zoomTarget: 1,
    offX: 0, offY: 0,                 // screen offset (device px) clearing the panel
    offXTarget: 0, offYTarget: 0,
    center: [0, 0, 0],
    radius: 1,
    reset: null,                      // { t, from } while animating
    lastInput: 0                      // timestamp of the last user interaction
};

let canvas, ctx = null, dpr = 1, width = 0, height = 0;
// Dynamic resolution: the light buffer shrinks on slow GPUs and grows back
// when there is headroom, so motion stays fluid on any machine.
const quality = { scale: 1, slow: 0, fast: 0 };
let dirty = true;
const k1 = new Float64Array(3), k2 = new Float64Array(3), k3 = new Float64Array(3), k4 = new Float64Array(3);

// --------------------------------------------------------------------------
// Integration
// --------------------------------------------------------------------------

/* Advance every particle by simulation time T using equal RK4 steps. */
function integrate(T) {
    const A = ATTRACTORS[state.type];
    const p = state.params[state.type];
    const f = A.deriv;
    const n = Math.max(1, Math.ceil(T / A.h));
    const h = T / n;
    const h2 = h / 2, h6 = h / 6;
    const esc2 = ref.escape * ref.escape;
    const cx = ref.center[0], cy = ref.center[1], cz = ref.center[2];

    for (let i = 0; i < count; i++) {
        let x = px[i], y = py[i], z = pz[i];
        for (let s = 0; s < n; s++) {
            f(x, y, z, p, k1);
            f(x + h2 * k1[0], y + h2 * k1[1], z + h2 * k1[2], p, k2);
            f(x + h2 * k2[0], y + h2 * k2[1], z + h2 * k2[2], p, k3);
            f(x + h * k3[0], y + h * k3[1], z + h * k3[2], p, k4);
            x += h6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
            y += h6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
            z += h6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        }
        const dx = x - cx, dy = y - cy, dz = z - cz;
        // Non-finite values fail this comparison too.
        if (!(dx * dx + dy * dy + dz * dz < esc2)) {
            spawn(i);
            continue;
        }
        px[i] = x; py[i] = y; pz[i] = z;
        pSpeed[i] = Math.hypot(k1[0], k1[1], k1[2]);
    }
}

/* Advance the simulation by T, committing history samples on schedule. */
function advance(T) {
    const eps = 1e-9;
    while (T > eps) {
        const chunk = Math.min(T, hist.interval - hist.clock);
        integrate(chunk);
        hist.clock += chunk;
        T -= chunk;
        if (hist.clock >= hist.interval - eps) {
            hist.clock = 0;
            writeSlot(hist.head);
            hist.head = (hist.head + 1) % hist.L;
        }
    }
    writeSlot(hist.head);
}

/* Place particle i on the attractor: a random reference sample plus a tiny
   offset, which chaos spreads along the attractor within seconds. */
function spawn(i) {
    const A = ATTRACTORS[state.type];
    if (ref.n > 0) {
        const j = (Math.random() * ref.n) | 0;
        const eps = ref.radius * 2e-3;
        px[i] = ref.pts[3 * j] + (Math.random() - 0.5) * eps;
        py[i] = ref.pts[3 * j + 1] + (Math.random() - 0.5) * eps;
        pz[i] = ref.pts[3 * j + 2] + (Math.random() - 0.5) * eps;
    } else {
        px[i] = A.seed[0] + (Math.random() - 0.5);
        py[i] = A.seed[1] + (Math.random() - 0.5);
        pz[i] = A.seed[2] + (Math.random() - 0.5);
    }
    pSpeed[i] = 0;
    resetHistory(i);
}

function spawnAll() {
    for (let i = 0; i < count; i++) spawn(i);
    dirty = true;
}

/* Integrate one orbit for a long time to learn the attractor's shape. */
function computeReference() {
    const res = sampleOrbit(ATTRACTORS[state.type], state.params[state.type]);
    applyReference(res);
}

/* Long orbit after the transient: REF_SAMPLES points and their speeds, or
   null if every attempt escaped to infinity. */
function sampleOrbit(A, p) {
    const f = A.deriv;
    const h = A.h;
    const out = new Float64Array(3);

    const tryFrom = (sx, sy, sz) => {
        let x = sx, y = sy, z = sz;
        const step = () => {
            f(x, y, z, p, k1);
            f(x + h / 2 * k1[0], y + h / 2 * k1[1], z + h / 2 * k1[2], p, k2);
            f(x + h / 2 * k2[0], y + h / 2 * k2[1], z + h / 2 * k2[2], p, k3);
            f(x + h * k3[0], y + h * k3[1], z + h * k3[2], p, k4);
            x += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
            y += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
            z += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
            return Number.isFinite(x + y + z) && Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e6;
        };
        // Discard the transient (about 60 time units), then sample ~200 more.
        const transient = Math.ceil((A.transient || 60) / h);
        for (let s = 0; s < transient; s++) if (!step()) return null;
        const stride = Math.max(1, Math.round((A.span || 200) / h / REF_SAMPLES));
        const pts = new Float64Array(REF_SAMPLES * 3);
        const speeds = new Float32Array(REF_SAMPLES);
        for (let j = 0; j < REF_SAMPLES; j++) {
            for (let s = 0; s < stride; s++) if (!step()) return null;
            pts[3 * j] = x; pts[3 * j + 1] = y; pts[3 * j + 2] = z;
            f(x, y, z, p, out);
            speeds[j] = Math.hypot(out[0], out[1], out[2]);
        }
        return { pts, speeds };
    };

    let res = tryFrom(...A.seed);
    for (let k = 0; !res && k < 6; k++) {
        const s = 0.5 + k;
        res = tryFrom(A.seed[0] + (Math.random() - 0.5) * s, A.seed[1] + (Math.random() - 0.5) * s, A.seed[2] + (Math.random() - 0.5) * s);
    }
    return res;
}

function applyReference(res) {
    if (!res) {
        // Keep the previous framing so the view does not jump.
        ref.status = "diverges";
        ref.n = 0;
        ref.escape = ref.radius * 50;
        updateStatus();
        return;
    }

    const { pts, speeds } = res;
    // Pivot on the median point: it sits in the bulk of the attractor and
    // ignores rare excursions such as the Rössler spike.
    const center = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
        const v = new Float64Array(REF_SAMPLES);
        for (let j = 0; j < REF_SAMPLES; j++) v[j] = pts[3 * j + d];
        v.sort();
        center[d] = v[REF_SAMPLES >> 1];
    }
    const dist = new Float64Array(REF_SAMPLES);
    for (let j = 0; j < REF_SAMPLES; j++) {
        dist[j] = Math.hypot(pts[3 * j] - center[0], pts[3 * j + 1] - center[1], pts[3 * j + 2] - center[2]);
    }
    dist.sort();
    const radius = dist[Math.floor(REF_SAMPLES * 0.999)];
    const s = speeds.slice().sort();

    ref.pts = pts;
    ref.n = REF_SAMPLES;
    ref.center = center;
    ref.status = radius < 1e-6 ? "fixed" : "ok";
    ref.radius = Math.max(radius, 1e-3);
    ref.escape = Math.max(ref.radius * 20, 10);
    ref.speedLo = Math.log(s[Math.floor(REF_SAMPLES * 0.03)] + 1e-9);
    ref.speedHi = Math.log(s[Math.floor(REF_SAMPLES * 0.97)] + 1e-9);
    if (ref.speedHi - ref.speedLo < 1e-6) ref.speedHi = ref.speedLo + 1;
    updateStatus();
}

// --------------------------------------------------------------------------
// Particle count and history
// --------------------------------------------------------------------------

function setCount(n) {
    n = Math.max(0, Math.min(MAX_PARTICLES, n | 0));
    const old = count;
    count = n;
    allocHistory();
    for (let i = 0; i < old && i < n; i++) resetHistory(i);
    for (let i = old; i < n; i++) spawn(i);
    dirty = true;
}

function allocHistory() {
    const n = Math.max(1, count);
    hist.L = Math.max(12, Math.min(64, Math.floor(HISTORY_BUDGET / n)));
    hist.W = Math.min(n, 2048);
    hist.R = Math.ceil(n / hist.W);
    hist.stride = hist.W * hist.R;
    hist.buf = new Float32Array(hist.L * hist.stride * 4);
    hist.head = 0;
    hist.clock = 0;
    updateHistoryInterval();
    hist.fullDirty = true;
    hist.dirtySlots.clear();
    if (gl) glResizeHistory();
}

/* Trails cover the same real time at every speed and particle count. */
function updateHistoryInterval() {
    const A = ATTRACTORS[state.type];
    hist.interval = TRAIL_SECONDS * A.timeScale / Math.max(1, hist.L - 1);
}

/* Collapse particle i's history onto its current position, so a respawned
   particle never draws a streak from where it used to be. */
function resetHistory(i) {
    if (!hist.buf || i >= count) return;
    const step = hist.stride * 4;
    for (let k = 0, o = i * 4; k < hist.L; k++, o += step) {
        hist.buf[o] = px[i];
        hist.buf[o + 1] = py[i];
        hist.buf[o + 2] = pz[i];
        hist.buf[o + 3] = pSpeed[i];
    }
    hist.fullDirty = true;
}

function writeSlot(slot) {
    const b = hist.buf;
    for (let i = 0, o = slot * hist.stride * 4; i < count; i++, o += 4) {
        b[o] = px[i];
        b[o + 1] = py[i];
        b[o + 2] = pz[i];
        b[o + 3] = pSpeed[i];
    }
    hist.dirtySlots.add(slot);
}

// --------------------------------------------------------------------------
// Orientation
// --------------------------------------------------------------------------

/* Rotation taking the attractor's up axis to +y (screen up). */
function alignUp(up) {
    const l = Math.hypot(up[0], up[1], up[2]);
    const u = [up[0] / l, up[1] / l, up[2] / l];
    const c = u[1];
    const ax = [-u[2], 0, u[0]];             // u × y
    const s = Math.hypot(ax[0], ax[2]);
    if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const kx = ax[0] / s, kz = ax[2] / s;
    const t = 1 - c;
    return [
        c + kx * kx * t, -kz * s, kx * kz * t,
        kz * s, c, -kx * s,
        kz * kx * t, kx * s, c + kz * kz * t
    ];
}

function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
    }
    return r;
}

let alignMatrix = alignUp(ATTRACTORS.lorenz.up);

function quatMul(a, b) {
    return [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
}

function quatNormalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function quatAxisAngle(x, y, z, angle) {
    const l = Math.hypot(x, y, z);
    if (l < 1e-12 || angle === 0) return [1, 0, 0, 0];
    const s = Math.sin(angle / 2) / l;
    return [Math.cos(angle / 2), x * s, y * s, z * s];
}

function quatSlerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map(v => -v); d = -d; }       // take the short way
    if (d > 0.9995) return quatNormalize(a.map((v, i) => v + (b[i] - v) * t));
    const th = Math.acos(d), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((v, i) => v * wa + b[i] * wb);
}

function quatToMat(q) {
    const [w, x, y, z] = q;
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    ];
}

/* Default orientation for an attractor: turn about the vertical, then tilt. */
function viewQuat([turn, tilt]) {
    return quatMul(quatAxisAngle(1, 0, 0, tilt), quatAxisAngle(0, 1, 0, turn));
}

/* Free trackball: rotate by `a` about the screen's vertical axis and `b`
   about its horizontal axis. Any amount, any direction. */
function rotateView(a, b) {
    const angle = Math.hypot(a, b);
    if (angle === 0) return;
    cam.q = quatNormalize(quatMul(quatAxisAngle(b, a, 0, angle), cam.q));
}

/* Turntable spin about the attractor's own up axis. */
function spinView(angle) {
    cam.q = quatNormalize(quatMul(cam.q, quatAxisAngle(0, 1, 0, angle)));
}

function viewMatrix() {
    return mul3(quatToMat(cam.q), alignMatrix);
}

/* Fit the attractor into the part of the screen the panel leaves free. */
function frameScale() {
    const w = Math.max(80, width - 2 * Math.abs(cam.offX));
    const h = Math.max(80, height - 2 * Math.abs(cam.offY));
    return 0.42 * Math.min(w, h) / cam.radius * cam.zoom;
}

// --------------------------------------------------------------------------
// WebGL 2 renderer
// --------------------------------------------------------------------------

let gl = null;
let glr = null;

const GL_PROJECT = `
uniform highp sampler2D uPos;
uniform int uW, uR, uHead, uLen;
uniform mat3 uView;
uniform vec3 uCenter;
uniform float uFocal, uCamDist, uRadius;
uniform vec2 uHalf;
uniform vec2 uOffset;                 // screen offset in pixels
uniform vec2 uSpeed;                  // log-speed low end, span
uniform vec3 uPalette[${PALETTE_SIZE}];

vec4 fetchSample(int i, int age) {
    int slot = (uHead - age + uLen * 4) % uLen;
    return texelFetch(uPos, ivec2(i % uW, slot * uR + i / uW), 0);
}
// Screen position in pixels from the centre; depth in 0..1 (1 = near).
vec2 project(vec3 p, out float depth) {
    vec3 v = uView * (p - uCenter);
    float w = uFocal / max(uCamDist - v.z, uRadius * 0.05);
    depth = clamp((v.z / uRadius + 1.0) * 0.5, 0.0, 1.0);
    return v.xy * w + uOffset;
}
vec3 colorFor(float speed) {
    float t = clamp((log(speed + 1e-9) - uSpeed.x) / uSpeed.y, 0.0, 1.0);
    float f = t * ${PALETTE_SIZE - 1}.0;
    int i0 = int(floor(f));
    int i1 = min(i0 + 1, ${PALETTE_SIZE - 1});
    return mix(uPalette[i0], uPalette[i1], fract(f));
}
`;

const TRAIL_VS = `#version 300 es
precision highp float;
precision highp int;
${GL_PROJECT}
uniform int uCount;
uniform float uWidth, uAlpha;
out vec3 vColor;
out float vAlpha;
out float vSide;
out float vHalf;
void main() {
    int i = gl_InstanceID % uCount;
    int age = gl_InstanceID / uCount;              // segment from age to age + 1
    vec4 a = fetchSample(i, age);
    vec4 b = fetchSample(i, age + 1);
    float da, db;
    vec2 sa = project(a.xyz, da);
    vec2 sb = project(b.xyz, db);
    vec2 d = sb - sa;
    float len = length(d);
    vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-dir.y, dir.x);

    float t = float(gl_VertexID >> 1);             // 0 at the newer end
    float side = float(gl_VertexID & 1) * 2.0 - 1.0;
    float u = (float(age) + t) / float(uLen - 1);  // 0 at the head, 1 at the tail
    float depth = mix(da, db, t);

    // A fine line that thins slightly towards the tail; the extra margin
    // leaves room for a one-pixel anti-aliased edge.
    float w = uWidth * (1.0 - 0.45 * u) * mix(0.8, 1.15, depth);
    float half_ = w * 0.5 + 1.0;
    vec2 s = mix(sa, sb, t) + n * side * half_;
    gl_Position = vec4(s / uHalf, 0.0, 1.0);

    vSide = side * half_;                          // distance from the centre line, px
    vHalf = w * 0.5;
    vColor = colorFor(t < 0.5 ? a.w : b.w);
    // Smooth comet tail: full at the head, easing to nothing.
    float fade = (1.0 - u) * (1.0 - u) * (3.0 - 2.0 * (1.0 - u));
    // Thin lines cover less than a pixel; keep their energy constant.
    float cover = min(1.0, w);
    vAlpha = uAlpha * fade * cover * mix(0.4, 1.0, depth) * (len > 1e-4 ? 1.0 : 0.0);
}`;

const TRAIL_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vSide;
in float vHalf;
out vec4 outColor;
void main() {
    // Crisp core with a one-pixel anti-aliased edge.
    float a = vAlpha * clamp(max(vHalf, 0.5) + 0.5 - abs(vSide), 0.0, 1.0);
    outColor = vec4(vColor * a, a);
}`;

const POINT_VS = `#version 300 es
precision highp float;
precision highp int;
${GL_PROJECT}
uniform float uSize, uAlpha;
out vec3 vColor;
out float vAlpha;
void main() {
    vec4 p = fetchSample(gl_VertexID, 0);
    float depth;
    vec2 s = project(p.xyz, depth);
    gl_Position = vec4(s / uHalf, 0.0, 1.0);
    vColor = colorFor(p.w);
    vAlpha = uAlpha * mix(0.4, 1.0, depth);
    gl_PointSize = uSize * mix(0.8, 1.15, depth);
}`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
out vec4 outColor;
void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    // Solid dot with a soft rim.
    float a = vAlpha * smoothstep(1.0, 0.35, sqrt(r2));
    outColor = vec4(vColor * a, a);
}`;

const QUAD_VS = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform float uExposure, uFade;
in vec2 vUv;
out vec4 outColor;
void main() {
    vec3 hdr = max(texture(uScene, vUv).rgb, 0.0);
    // Hue-preserving tone map: compress the brightest channel and scale the
    // others with it, so overlapping trails get brighter, never white.
    float m = max(hdr.r, max(hdr.g, hdr.b));
    vec3 c = m > 1e-5 ? hdr * ((1.0 - exp(-m * uExposure)) / m) : vec3(0.0);
    // Dither away banding in the faint tails.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) / 255.0;
    outColor = vec4(c * uFade, 1.0);
}`;

function compileProgram(vsSrc, fsSrc) {
    const make = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, "");
        u[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, u };
}

function initGL() {
    const context = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: "high-performance"
    });
    if (!context) return false;
    gl = context;
    try {
        const hdr = !!gl.getExtension("EXT_color_buffer_float");
        glr = {
            hdr,
            trail: compileProgram(TRAIL_VS, TRAIL_FS),
            point: compileProgram(POINT_VS, POINT_FS),
            composite: compileProgram(QUAD_VS, COMPOSITE_FS),
            vao: gl.createVertexArray(),          // attribute-less drawing
            posTex: gl.createTexture(),
            targets: null,
            palette: new Float32Array(PALETTE_SIZE * 3),
            paletteFor: null
        };
        gl.bindTexture(gl.TEXTURE_2D, glr.posTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } catch (err) {
        console.warn("WebGL 2 renderer unavailable, using Canvas 2D.", err);
        gl = null;
        glr = null;
        return false;
    }
    canvas.addEventListener("webglcontextlost", e => e.preventDefault());
    canvas.addEventListener("webglcontextrestored", () => location.reload());
    return true;
}

function glResizeHistory() {
    gl.bindTexture(gl.TEXTURE_2D, glr.posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, hist.W, hist.R * hist.L, 0, gl.RGBA, gl.FLOAT, null);
    hist.fullDirty = true;
}

function makeTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (glr.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
}

function glResizeTargets(sw, sh) {
    if (glr.targets) {
        for (const t of Object.values(glr.targets)) {
            gl.deleteTexture(t.tex);
            gl.deleteFramebuffer(t.fbo);
        }
    }
    glr.targets = { scene: makeTarget(sw, sh) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function uploadHistory() {
    gl.bindTexture(gl.TEXTURE_2D, glr.posTex);
    if (hist.fullDirty) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, hist.W, hist.R * hist.L, gl.RGBA, gl.FLOAT, hist.buf);
        hist.fullDirty = false;
    } else {
        for (const slot of hist.dirtySlots) {
            const off = slot * hist.stride * 4;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, slot * hist.R, hist.W, hist.R, gl.RGBA, gl.FLOAT,
                hist.buf.subarray(off, off + hist.stride * 4));
        }
    }
    hist.dirtySlots.clear();
}

function setSceneUniforms(u, M) {
    const r = cam.radius;
    const camDist = 4.5 * r;
    gl.uniform1i(u.uPos, 0);
    gl.uniform1i(u.uW, hist.W);
    gl.uniform1i(u.uR, hist.R);
    gl.uniform1i(u.uHead, hist.head);
    gl.uniform1i(u.uLen, hist.L);
    // GLSL matrices are column-major.
    gl.uniformMatrix3fv(u.uView, false, [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
    gl.uniform3f(u.uCenter, cam.center[0], cam.center[1], cam.center[2]);
    gl.uniform1f(u.uFocal, frameScale() * camDist);
    gl.uniform1f(u.uCamDist, camDist);
    gl.uniform1f(u.uRadius, r);
    gl.uniform2f(u.uHalf, width / 2, height / 2);
    gl.uniform2f(u.uOffset, cam.offX, cam.offY);
    gl.uniform2f(u.uSpeed, ref.speedLo, ref.speedHi - ref.speedLo);
    if (glr.paletteFor !== state.palette) {
        state.palette.forEach((c, i) => glr.palette.set([c[0] / 255, c[1] / 255, c[2] / 255], i * 3));
        glr.paletteFor = state.palette;
    }
    gl.uniform3fv(u.uPalette, glr.palette);
}

function drawQuad(prog, target, setup) {
    gl.useProgram(prog.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : width, target ? target.h : height);
    setup(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
}

function renderGL() {
    const sw = Math.max(1, Math.round(width * quality.scale));
    const sh = Math.max(1, Math.round(height * quality.scale));
    if (!glr.targets || glr.targets.scene.w !== sw || glr.targets.scene.h !== sh) glResizeTargets(sw, sh);
    const rs = quality.scale;
    gl.activeTexture(gl.TEXTURE0);
    uploadHistory();
    const T = glr.targets;
    gl.bindVertexArray(glr.vao);

    // 1. Scene: additive light into the HDR buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (count > 0) {
        const M = viewMatrix();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        bindTex(0, glr.posTex);
        // Dense clouds get less energy per particle so structure stays visible.
        const density = Math.min(1.4, Math.max(0.25, Math.sqrt(2500 / count)));

        if (state.trailFade > 0 && hist.L > 1) {
            const t = glr.trail;
            gl.useProgram(t.prog);
            setSceneUniforms(t.u, M);
            gl.uniform1i(t.u.uCount, count);
            gl.uniform1f(t.u.uWidth, rs * dpr * 1.15 * Math.min(1.5, Math.sqrt(cam.zoom)));
            gl.uniform1f(t.u.uAlpha, 0.55 * density * state.trailFade);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count * (hist.L - 1));
        }

        const p = glr.point;
        gl.useProgram(p.prog);
        setSceneUniforms(p.u, M);
        gl.uniform1f(p.u.uSize, rs * dpr * Math.min(3.6, Math.max(2.2, 3.8 - count / 6000)) * Math.min(1.6, Math.sqrt(cam.zoom)));
        gl.uniform1f(p.u.uAlpha, density * (1.0 - 0.3 * state.trailFade));
        gl.drawArrays(gl.POINTS, 0, count);
        gl.disable(gl.BLEND);
    }

    // 2. Tone-map to the screen.
    drawQuad(glr.composite, null, u => {
        bindTex(0, T.scene.tex);
        gl.uniform1i(u.uScene, 0);
        gl.uniform1f(u.uExposure, 1.25);
        gl.uniform1f(u.uFade, state.sceneFade);
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
}

// --------------------------------------------------------------------------
// Canvas 2D fallback (browsers without WebGL 2)
// --------------------------------------------------------------------------

function render2D() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    if (count === 0) return;

    const M = viewMatrix();
    const [ccx, ccy, ccz] = cam.center;
    const r = cam.radius;
    const camDist = 4.5 * r;
    const focal = frameScale() * camDist;
    const ox = width / 2 + cam.offX, oy = height / 2 - cam.offY;
    const css = state.palette.map(c => `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
    const span = ref.speedHi - ref.speedLo;
    const proj = (x, y, z) => {
        x -= ccx; y -= ccy; z -= ccz;
        const vx = M[0] * x + M[1] * y + M[2] * z;
        const vy = M[3] * x + M[4] * y + M[5] * z;
        const vz = M[6] * x + M[7] * y + M[8] * z;
        const w = focal / Math.max(camDist - vz, r * 0.05);
        return [ox + vx * w, oy - vy * w];
    };
    const colorIndex = s => Math.max(0, Math.min(PALETTE_SIZE - 1, ((Math.log(s + 1e-9) - ref.speedLo) / span * (PALETTE_SIZE - 1)) | 0));

    ctx.globalCompositeOperation = "lighter";

    // Trails: a subset of particles keeps the CPU cost bounded.
    if (state.trailFade > 0 && hist.L > 1) {
        const step = Math.max(1, Math.ceil(count / 1500));
        const b = hist.buf, stride = hist.stride * 4, L = hist.L;
        ctx.lineWidth = dpr;
        ctx.globalAlpha = 0.35 * state.trailFade * state.sceneFade;
        for (let i = 0; i < count; i += step) {
            ctx.strokeStyle = css[colorIndex(pSpeed[i])];
            ctx.beginPath();
            for (let a = 0; a < L - 1; a++) {
                const slot = (hist.head - a + L) % L;
                const o = slot * stride + i * 4;
                const [sx, sy] = proj(b[o], b[o + 1], b[o + 2]);
                if (a === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
        }
    }

    ctx.globalAlpha = state.sceneFade;
    const size = 1.8 * dpr;
    let lastColor = -1;
    for (let i = 0; i < count; i++) {
        const c = colorIndex(pSpeed[i]);
        if (c !== lastColor) { ctx.fillStyle = css[c]; lastColor = c; }
        const [sx, sy] = proj(px[i], py[i], pz[i]);
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
}

function render() {
    if (gl) renderGL();
    else render2D();
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

let lastTime = 0;
let smoothDt = 1 / 60;
let refPending = false;
const keysDown = new Set();

function frame(now) {
    requestAnimationFrame(frame);
    // Clamp hitches and smooth timestamp jitter so motion stays even.
    const raw = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;
    smoothDt += (Math.min(raw, 1 / 20) - smoothDt) * 0.25;
    const dt = raw > 0 ? smoothDt : 0;

    if (refPending) {
        refPending = false;
        computeReference();
    }

    let moving = updateCamera(dt, now);
    if (updateFades(dt)) moving = true;
    if (updateMorph(dt)) moving = true;

    if (!state.paused && state.speed > 0 && count > 0 && dt > 0 && !state.pendingType) {
        advance(dt * state.speed * ATTRACTORS[state.type].timeScale);
        dirty = true;
    }

    if (moving || dirty) {
        render();
        dirty = false;
        if (gl) adaptQuality(raw);
    }
    fpsTick(now);
}

function adaptQuality(frameTime) {
    if (frameTime <= 0) return;
    if (frameTime > 1 / 45) { quality.slow++; quality.fast = 0; }
    else if (frameTime < 1 / 57) { quality.fast++; quality.slow = 0; }
    if (quality.slow > 45 && quality.scale > 0.5) {
        quality.scale = Math.max(0.5, quality.scale - 0.15);
        quality.slow = 0;
    } else if (quality.fast > 240 && quality.scale < 1) {
        quality.scale = Math.min(1, quality.scale + 0.1);
        quality.fast = 0;
    }
}

/* Trails and attractor switches fade instead of popping. */
function updateFades(dt) {
    let changed = false;
    const target = state.trails ? 1 : 0;
    if (state.trailFade !== target) {
        const step = dt / 0.45;
        state.trailFade = target > state.trailFade ? Math.min(1, state.trailFade + step) : Math.max(0, state.trailFade - step);
        changed = true;
    }
    if (state.pendingType) {
        state.sceneFade = Math.max(0, state.sceneFade - dt / 0.22);
        if (state.sceneFade === 0) {
            const type = state.pendingType;
            state.pendingType = null;
            applyAttractor(type);
        }
        changed = true;
    } else if (state.sceneFade < 1) {
        state.sceneFade = Math.min(1, state.sceneFade + dt / 0.35);
        changed = true;
    }
    return changed;
}

/* Lucky morphs the parameters smoothly into the chosen preset. */
function updateMorph(dt) {
    const m = state.morph;
    if (!m) return false;
    m.t = Math.min(1, m.t + dt / 1.8);
    const e = m.t < 0.5 ? 4 * m.t ** 3 : 1 - (-2 * m.t + 2) ** 3 / 2;
    const p = state.params[state.type];
    for (const key in m.to) p[key] = m.from[key] + (m.to[key] - m.from[key]) * e;
    syncParamControls();
    if (m.t >= 1) state.morph = null;
    return true;
}

/* Returns true while the view is still changing. */
function updateCamera(dt, now) {
    let moving = false;

    // Drag: follow the pointer with a very short ease (~35 ms), which hides
    // the irregular timing of pointer events without feeling laggy.
    if (cam.pendA !== 0 || cam.pendB !== 0) {
        const f = dt > 0 ? 1 - Math.exp(-dt / 0.035) : 0;
        const a = cam.pendA * f, b = cam.pendB * f;
        rotateView(a, b);
        cam.pendA -= a;
        cam.pendB -= b;
        if (pointer.dragging && dt > 0) {
            // Angular velocity estimate for the glide after release.
            const k = Math.min(1, dt / 0.06);
            cam.velA += (a / dt - cam.velA) * k;
            cam.velB += (b / dt - cam.velB) * k;
        }
        if (Math.abs(cam.pendA) < 1e-5 && Math.abs(cam.pendB) < 1e-5) cam.pendA = cam.pendB = 0;
        moving = true;
    } else if (pointer.dragging && dt > 0) {
        // Holding still while dragging bleeds off the velocity.
        const decay = Math.exp(-dt / 0.05);
        cam.velA *= decay;
        cam.velB *= decay;
    }

    // Held arrow keys spin the view at a constant rate.
    if (keysDown.size) {
        const rate = 1.6;
        const ka = (keysDown.has("ArrowRight") ? 1 : 0) - (keysDown.has("ArrowLeft") ? 1 : 0);
        const kb = (keysDown.has("ArrowDown") ? 1 : 0) - (keysDown.has("ArrowUp") ? 1 : 0);
        if (ka || kb) { rotateView(ka * rate * dt, kb * rate * dt); moving = true; cam.lastInput = now; }
        if (keysDown.has("+")) cam.zoomTarget = clampZoom(cam.zoomTarget * Math.exp(1.4 * dt));
        if (keysDown.has("-")) cam.zoomTarget = clampZoom(cam.zoomTarget * Math.exp(-1.4 * dt));
    }

    // Glide after release: exponential decay, independent of frame rate.
    if (!pointer.dragging && (cam.velA !== 0 || cam.velB !== 0)) {
        rotateView(cam.velA * dt, cam.velB * dt);
        const decay = Math.exp(-dt * 2.2);
        cam.velA *= decay;
        cam.velB *= decay;
        if (Math.hypot(cam.velA, cam.velB) < 0.005) cam.velA = cam.velB = 0;
        moving = true;
    }

    // Gentle turntable spin once the viewer has been idle for a moment.
    const idle = (now - cam.lastInput) / 1000;
    const spinTarget = state.spin && !pointer.dragging && !cam.reset && idle > 2.5 && Math.hypot(cam.velA, cam.velB) < 0.05 ? 0.14 : 0;
    cam.spinRate += (spinTarget - cam.spinRate) * (1 - Math.exp(-dt * (spinTarget > cam.spinRate ? 0.8 : 6)));
    if (Math.abs(cam.spinRate) > 1e-4) { spinView(cam.spinRate * dt); moving = true; }
    else cam.spinRate = 0;

    // Animated view reset.
    if (cam.reset) {
        cam.reset.t = Math.min(1, cam.reset.t + dt / 0.8);
        const t = cam.reset.t;
        const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        cam.q = quatSlerp(cam.reset.from, viewQuat(ATTRACTORS[state.type].view), e);
        if (t >= 1) cam.reset = null;
        moving = true;
    }

    // Zoom eases toward its target in log space.
    const lz = Math.log(cam.zoom), lt = Math.log(cam.zoomTarget);
    if (Math.abs(lt - lz) > 1e-4) {
        cam.zoom = Math.exp(lz + (lt - lz) * (1 - Math.exp(-dt * 10)));
        moving = true;
    } else {
        cam.zoom = cam.zoomTarget;
    }

    // The free area shifts smoothly when the panel opens or closes.
    const oe = 1 - Math.exp(-dt * 7);
    if (Math.abs(cam.offXTarget - cam.offX) > 0.3 || Math.abs(cam.offYTarget - cam.offY) > 0.3) {
        cam.offX += (cam.offXTarget - cam.offX) * oe;
        cam.offY += (cam.offYTarget - cam.offY) * oe;
        moving = true;
    } else {
        cam.offX = cam.offXTarget;
        cam.offY = cam.offYTarget;
    }

    // Framing follows the attractor when parameters change.
    const ease = 1 - Math.exp(-dt * 3);
    for (let d = 0; d < 3; d++) {
        const delta = ref.center[d] - cam.center[d];
        if (Math.abs(delta) > ref.radius * 1e-4) { cam.center[d] += delta * ease; moving = true; }
        else cam.center[d] = ref.center[d];
    }
    const lr = Math.log(cam.radius), lrt = Math.log(ref.radius);
    if (Math.abs(lrt - lr) > 1e-4) { cam.radius = Math.exp(lr + (lrt - lr) * ease); moving = true; }
    else cam.radius = ref.radius;

    return moving;
}

function clampZoom(z) {
    return Math.max(0.25, Math.min(12, z));
}

function resetView() {
    cam.velA = cam.velB = cam.pendA = cam.pendB = 0;
    cam.reset = { t: 0, from: cam.q.slice() };
    cam.zoomTarget = 1;
    cam.lastInput = performance.now();
}

// --------------------------------------------------------------------------
// Pointer input: one pointer rotates, two pointers pinch-zoom.
// --------------------------------------------------------------------------

const pointer = {
    active: new Map(),               // pointerId -> {x, y}
    dragging: false,
    lastX: 0, lastY: 0, lastMove: 0,
    pinchDist: 0,
    lastTap: 0
};
const ROTATE_PER_PX = 0.0055;

function noteInput() {
    cam.lastInput = performance.now();
}

function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointer.active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    noteInput();
    cam.reset = null;
    if (pointer.active.size === 1) {
        // Grabbing stops any glide, like catching a spinning globe.
        cam.velA = cam.velB = 0;
        pointer.dragging = true;
        pointer.lastX = e.clientX;
        pointer.lastY = e.clientY;
        pointer.lastMove = e.timeStamp;
        canvas.classList.add("dragging");
        if (e.pointerType === "touch") {
            if (e.timeStamp - pointer.lastTap < 300) resetView();
            pointer.lastTap = e.timeStamp;
        }
    } else if (pointer.active.size === 2) {
        pointer.dragging = false;
        cam.velA = cam.velB = 0;
        pointer.pinchDist = pinchDistance();
    }
}

function onPointerMove(e) {
    if (!pointer.active.has(e.pointerId)) return;
    pointer.active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    noteInput();

    if (pointer.active.size === 2) {
        const d = pinchDistance();
        if (pointer.pinchDist > 0 && d > 0) {
            cam.zoomTarget = clampZoom(cam.zoomTarget * d / pointer.pinchDist);
        }
        pointer.pinchDist = d;
        return;
    }
    if (!pointer.dragging) return;
    cam.pendA += (e.clientX - pointer.lastX) * ROTATE_PER_PX;
    cam.pendB += (e.clientY - pointer.lastY) * ROTATE_PER_PX;
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    pointer.lastMove = e.timeStamp;
}

function onPointerUp(e) {
    if (!pointer.active.has(e.pointerId)) return;
    pointer.active.delete(e.pointerId);
    if (pointer.dragging && pointer.active.size === 0) {
        // Only glide if the pointer was still moving at release.
        if (e.timeStamp - pointer.lastMove > 70) cam.velA = cam.velB = 0;
        const max = 6;
        cam.velA = Math.max(-max, Math.min(max, cam.velA));
        cam.velB = Math.max(-max, Math.min(max, cam.velB));
    }
    if (pointer.active.size === 1) {
        // Back from pinch to rotate: continue from the remaining finger.
        const [p] = pointer.active.values();
        pointer.dragging = true;
        pointer.lastX = p.x;
        pointer.lastY = p.y;
        pointer.lastMove = e.timeStamp;
    } else if (pointer.active.size === 0) {
        pointer.dragging = false;
        canvas.classList.remove("dragging");
    }
    noteInput();
}

function pinchDistance() {
    const [a, b] = pointer.active.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function onWheel(e) {
    e.preventDefault();
    noteInput();
    // Normalise line/page deltas to pixels so mice and trackpads match.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= height / dpr;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    dy = Math.max(-200, Math.min(200, dy));
    cam.zoomTarget = clampZoom(cam.zoomTarget * Math.exp(-dy * k));
}

// --------------------------------------------------------------------------
// Keyboard
// --------------------------------------------------------------------------

function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function onKeyDown(e) {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    noteInput();

    if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) togglePause();
    } else if (e.key === "Enter") {
        e.preventDefault();
        restartParticles();
    } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        cam.reset = null;
        cam.velA = cam.velB = 0;
        keysDown.add(e.key);
    } else if (e.key === "+" || e.key === "=") {
        keysDown.add("+");
    } else if (e.key === "-" || e.key === "_") {
        keysDown.add("-");
    } else if (e.key === "r" || e.key === "R") {
        resetView();
    } else if (e.key === "t" || e.key === "T") {
        toggleTrails();
    } else if (e.key === "s" || e.key === "S") {
        toggleSpin();
    } else if (e.key === "l" || e.key === "L") {
        lucky();
    } else if (e.key === "h" || e.key === "H") {
        togglePanel();
    } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
    } else if (e.key === "?") {
        openHelp();
    }
}

function onKeyUp(e) {
    keysDown.delete(e.key);
    if (e.key === "=") keysDown.delete("+");
    if (e.key === "_") keysDown.delete("-");
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

const $ = id => document.getElementById(id);
let paramInputs = {};
const isPhone = () => window.matchMedia("(max-width: 760px)").matches;

function setPressed(id, on) {
    $(id).setAttribute("aria-checked", String(on));
}

function togglePause() {
    state.paused = !state.paused;
    const b = $("playBtn");
    b.classList.toggle("paused", state.paused);
    const label = state.paused ? "Play" : "Pause";
    b.title = `${label} (Space)`;
    b.setAttribute("aria-label", label);
}

function toggleTrails() {
    state.trails = !state.trails;
    setPressed("trailsSwitch", state.trails);
    dirty = true;
}

function toggleSpin() {
    state.spin = !state.spin;
    setPressed("spinSwitch", state.spin);
    if (state.spin) cam.lastInput = performance.now() - 2000;
}

/* Fade out, switch, fade back in. */
function setAttractor(type) {
    if (type === state.type && !state.pendingType) return;
    state.morph = null;
    state.pendingType = type;
    markSelectedCard(type);
}

function applyAttractor(type) {
    state.type = type;
    alignMatrix = alignUp(ATTRACTORS[type].up);
    computeReference();
    cam.center = ref.center.slice();
    cam.radius = ref.radius;
    cam.q = viewQuat(ATTRACTORS[type].view);
    cam.velA = cam.velB = cam.pendA = cam.pendB = 0;
    cam.reset = null;
    cam.zoom = cam.zoomTarget = 1;
    applyRecommended(type);
    if (count !== state.count) setCount(state.count);
    else updateHistoryInterval();
    spawnAll();
    markSelectedCard(type);
    $("sheetCurrent").textContent = ATTRACTORS[type].short || ATTRACTORS[type].name;
    buildEquations();
    buildParamControls();
}

/* Each attractor opens with the particle count that renders it best, at 1×
   speed (its time scale is already tuned per attractor). */
function applyRecommended(type) {
    const n = recommendedCount(type);
    state.speed = 1;
    state.count = n;
    setRange("speed", 1);
    $("speedVal").textContent = "1.0×";
    setRange("particleCount", n);
    $("particleCountVal").textContent = n.toLocaleString("en-US");
}

/* Phones and tablets get fewer particles: the same look at a frame rate
   their GPUs can hold. */
function recommendedCount(type) {
    const n = ATTRACTORS[type].count;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    return touch ? Math.max(1500, Math.round(n * 0.6 / 500) * 500) : n;
}

function restartParticles() {
    spawnAll();
}

function resetParams() {
    state.morph = null;
    state.params[state.type] = { ...ATTRACTORS[state.type].params };
    computeReference();
    syncParamControls();
}

/* Lucky: morph into a curated preset, never the one already showing. */
function lucky() {
    const A = ATTRACTORS[state.type];
    const current = state.params[state.type];
    const isCurrent = p => Object.keys(p.params).every(k => Math.abs(p.params[k] - current[k]) < 1e-6);
    const choices = A.presets.filter(p => !isCurrent(p) && p !== state.lastPreset[state.type]);
    const pick = choices[(Math.random() * choices.length) | 0] || A.presets[0];
    state.lastPreset[state.type] = pick;

    // Frame and respawn against the target attractor, then morph toward it.
    const from = { ...current };
    state.params[state.type] = { ...pick.params };
    computeReference();
    state.params[state.type] = { ...from };
    state.morph = { from, to: { ...pick.params }, t: 0 };
    showToast(`${A.name} · ${pick.name}`);
}

let toastTimer = 0;
function showToast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function formatValue(v, step) {
    const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step))));
    return v.toFixed(decimals);
}

/* Range inputs paint their filled part from --fill (WebKit has no
   progress pseudo-element). */
function paintRange(input) {
    const min = +input.min, max = +input.max;
    input.style.setProperty("--fill", `${((+input.value - min) / (max - min)) * 100}%`);
}

function setRange(id, value) {
    const el = typeof id === "string" ? $(id) : id;
    el.value = value;
    paintRange(el);
}

// ---- Equations: parameters appear as highlighted symbols ----------------

function escapeHtml(t) {
    return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function eqToHtml(src, meta) {
    return src.split(/(\{\w+\})/).map(part => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m) return `<span class="p" data-p="${m[1]}">${meta[m[1]].sym}</span>`;
        // Binary operators (written with spaces) get math spacing; unary
        // minus and everything else is set tight.
        return escapeHtml(part)
            .replace(/\s*([-+])\s+/g, (_, op) => `\u0001${op}\u0002`)
            .replace(/\s+/g, "")
            .replace(/\u0001([-+])\u0002/g, '<span class="op">$1</span>')
            .replace(/-/g, "−")
            .replace(/\^2/g, "²")
            .replace(/\^3/g, "³")
            .replace(/([xyz])/g, "<i>$1</i>");
    }).join("");
}

function buildEquations() {
    const A = ATTRACTORS[state.type];
    $("equations").innerHTML = A.eq.map(([lhs, rhs]) =>
        `<span class="lhs">${lhs}</span><span class="eq">${lhs ? "=" : ""}</span><span class="rhs">${eqToHtml(rhs, A.meta)}</span>`
    ).join("") + (A.note ? `<span class="eq-note">${escapeHtml(A.note)}</span>` : "");
    $("equations").querySelectorAll(".p").forEach(el => {
        el.addEventListener("pointerenter", () => highlightParam(el.dataset.p, true));
        el.addEventListener("pointerleave", () => highlightParam(el.dataset.p, false));
    });
}

const activeParams = new Set();
function highlightParam(key, on) {
    if (on) activeParams.add(key); else activeParams.delete(key);
    const active = activeParams.has(key);
    document.querySelectorAll(`#equations .p[data-p="${key}"]`).forEach(el => el.classList.toggle("active", active));
    paramInputs[key]?.row.classList.toggle("active", active);
}

// ---- Parameter sliders ----------------------------------------------------

function buildParamControls() {
    const container = $("params");
    const A = ATTRACTORS[state.type];
    const params = state.params[state.type];
    container.textContent = "";
    paramInputs = {};
    activeParams.clear();
    const keys = Object.keys(A.params);
    container.style.setProperty("--cols", keys.length > 3 ? 2 : 1);

    for (const key of keys) {
        const range = A.ranges[key];
        const meta = A.meta[key];
        const row = document.createElement("div");
        row.className = "param";
        row.innerHTML = `
            <div class="param-row">
                <span class="sym" aria-hidden="true">${meta.sym}</span>
                <label class="pname" for="param-${key}">${meta.name}</label>
                <output class="pval" for="param-${key}"></output>
            </div>
            <input type="range" id="param-${key}" min="${range.min}" max="${range.max}" step="${range.step}"
                aria-label="${meta.name} (${meta.sym})" />`;
        const input = row.querySelector("input");
        const value = row.querySelector("output");
        setRange(input, params[key]);
        value.textContent = formatValue(params[key], range.step);

        input.addEventListener("input", () => {
            state.morph = null;
            const v = parseFloat(input.value);
            state.params[state.type][key] = v;
            value.textContent = formatValue(v, range.step);
            paintRange(input);
            updateResetState();
            // Recompute the reference orbit at most once per frame.
            refPending = true;
        });
        // Double-click a slider to restore its default.
        input.addEventListener("dblclick", () => {
            input.value = A.params[key];
            input.dispatchEvent(new Event("input"));
        });

        // Highlight the symbol in the equations while hovering, focusing or dragging.
        let hovering = false, focused = false, dragging = false;
        const sync = () => highlightParam(key, hovering || focused || dragging);
        row.addEventListener("pointerenter", () => { hovering = true; sync(); });
        row.addEventListener("pointerleave", () => { hovering = false; sync(); });
        input.addEventListener("focus", () => { focused = input.matches(":focus-visible"); sync(); });
        input.addEventListener("blur", () => { focused = false; sync(); });
        input.addEventListener("pointerdown", () => {
            dragging = true; sync();
            window.addEventListener("pointerup", () => { dragging = false; sync(); }, { once: true });
        });

        paramInputs[key] = { input, value, row, step: range.step };
        container.appendChild(row);
    }
    updateResetState();
}

function syncParamControls() {
    const p = state.params[state.type];
    for (const key in paramInputs) {
        const { input, value, step } = paramInputs[key];
        setRange(input, p[key]);
        value.textContent = formatValue(p[key], step);
    }
    updateResetState();
}

function updateResetState() {
    const A = ATTRACTORS[state.type];
    const p = state.params[state.type];
    const changed = Object.keys(A.params).some(k => Math.abs(p[k] - A.params[k]) > 1e-9);
    $("resetParamsBtn").disabled = !changed;
}

function updateStatus() {
    const el = $("statusBadge");
    if (!el) return;
    const msg = ref.status === "diverges"
        ? "These parameters diverge: orbits escape to infinity."
        : ref.status === "fixed"
            ? "These parameters settle to a fixed point."
            : "";
    el.textContent = msg;
    el.hidden = !msg;
}

// ---- Attractor cards with live-drawn previews ----------------------------

const thumbs = {};

function buildAttractorCards() {
    const grid = $("attractorGrid");
    for (const type of Object.keys(ATTRACTORS)) {
        const A = ATTRACTORS[type];
        const card = document.createElement("button");
        card.type = "button";
        card.className = "att-card";
        card.setAttribute("role", "radio");
        card.setAttribute("aria-checked", "false");
        card.dataset.type = type;
        card.innerHTML = `<canvas class="att-thumb" aria-hidden="true"></canvas><span class="att-name">${A.short || A.name}</span>`;
        card.title = A.name;
        card.addEventListener("click", () => setAttractor(type));
        grid.appendChild(card);
        // The default orbit, sampled once, is redrawn when the palette changes.
        thumbs[type] = { canvas: card.querySelector("canvas"), orbit: sampleOrbit(A, A.params) };
    }
    // Arrow keys move between cards, as in any radio group.
    grid.addEventListener("keydown", e => {
        const types = Object.keys(ATTRACTORS);
        const i = types.indexOf(state.pendingType || state.type);
        const cols = isPhone() ? 1 : 3;
        const d = { ArrowRight: 1, ArrowDown: cols, ArrowLeft: -1, ArrowUp: -cols }[e.key];
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        const next = types[(i + d + types.length) % types.length];
        setAttractor(next);
        grid.querySelector(`[data-type="${next}"]`).focus();
    });
    drawThumbs();
}

function markSelectedCard(type) {
    document.querySelectorAll(".att-card").forEach(c => {
        const on = c.dataset.type === type;
        c.setAttribute("aria-checked", String(on));
        c.tabIndex = on ? 0 : -1;
        if (on && isPhone()) c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    });
}

function drawThumbs() {
    for (const type in thumbs) {
        const { canvas: c, orbit } = thumbs[type];
        const A = ATTRACTORS[type];
        const r = window.devicePixelRatio > 1 ? 2 : 1;
        const w = c.clientWidth || 140, h = c.clientHeight || 88;
        c.width = Math.round(w * r);
        c.height = Math.round(h * r);
        const g = c.getContext("2d");
        g.fillStyle = "#04050a";
        g.fillRect(0, 0, c.width, c.height);
        if (!orbit) continue;

        const M = mul3(quatToMat(viewQuat(A.view)), alignUp(A.up));
        const n = REF_SAMPLES, xs = new Float32Array(n), ys = new Float32Array(n);
        for (let j = 0; j < n; j++) {
            const x = orbit.pts[3 * j], y = orbit.pts[3 * j + 1], z = orbit.pts[3 * j + 2];
            xs[j] = M[0] * x + M[1] * y + M[2] * z;
            ys[j] = -(M[3] * x + M[4] * y + M[5] * z);
        }
        // Frame the bulk of the orbit; rare excursions may touch the edge.
        const sx = xs.slice().sort(), sy = ys.slice().sort();
        const lo = Math.floor(n * 0.002), hi = n - 1 - lo;
        const minX = sx[lo], maxX = sx[hi], minY = sy[lo], maxY = sy[hi];
        const pad = 0.1;
        const k = Math.min(c.width * (1 - 2 * pad) / (maxX - minX), c.height * (1 - 2 * pad) / (maxY - minY));
        const ox = c.width / 2 - k * (minX + maxX) / 2, oy = c.height / 2 - k * (minY + maxY) / 2;
        const speeds = orbit.speeds, sorted = speeds.slice().sort();
        const sLo = Math.log(sorted[Math.floor(n * 0.03)] + 1e-9), sHi = Math.log(sorted[Math.floor(n * 0.97)] + 1e-9);

        g.lineWidth = 0.7 * r;
        g.lineJoin = "round";
        for (let j = 1; j < n; j++) {
            const t = Math.max(0, Math.min(1, (Math.log(speeds[j] + 1e-9) - sLo) / (sHi - sLo || 1)));
            const col = state.palette[Math.round(t * (PALETTE_SIZE - 1))];
            g.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.7)`;
            g.beginPath();
            g.moveTo(ox + xs[j - 1] * k, oy + ys[j - 1] * k);
            g.lineTo(ox + xs[j] * k, oy + ys[j] * k);
            g.stroke();
        }
    }
}

// ---- Palette swatches -----------------------------------------------------

function buildPaletteSwatches() {
    const row = $("paletteRow");
    for (const name of Object.keys(SCHEMES)) {
        const pal = buildPalette(name);
        const stops = [0, 8, 16, 24, 31].map(i => `rgb(${pal[i].join(",")})`).join(", ");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "swatch";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(name === state.scheme));
        b.setAttribute("aria-label", SCHEMES[name].label);
        b.title = b.getAttribute("aria-label");
        b.style.background = `linear-gradient(90deg, ${stops})`;
        b.dataset.scheme = name;
        b.addEventListener("click", () => setScheme(name));
        row.appendChild(b);
    }
}

function setScheme(name) {
    state.scheme = name;
    state.palette = buildPalette(name);
    document.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-checked", String(b.dataset.scheme === name)));
    applyAccent();
    drawThumbs();
    dirty = true;
}

/* The interface accent follows the palette. */
function applyAccent() {
    const hex = (SCHEMES[state.scheme] || SCHEMES.spectrum).accent;
    const [r, g, b] = hexToRgb(hex);
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    root.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.18)`);
}

// ---- Panel, sheet, dialog, fullscreen ------------------------------------

function togglePanel() {
    if (isPhone()) {
        toggleSheet();
        return;
    }
    const panel = $("panel");
    const hide = !panel.classList.contains("collapsed");
    panel.classList.toggle("collapsed", hide);
    panel.inert = hide;
    $("showPanelBtn").hidden = !hide;
    if (hide) $("showPanelBtn").focus({ preventScroll: true });
    updateLayout();
}

function toggleSheet() {
    const panel = $("panel");
    const closed = panel.classList.toggle("sheet-closed");
    $("sheetToggle").setAttribute("aria-expanded", String(!closed));
    updateLayout();
}

/* Keep the attractor centred in the space the controls leave free. */
function updateLayout() {
    const panel = $("panel");
    let offX = 0, offY = 0;
    if (isPhone()) {
        panel.classList.remove("collapsed");
        panel.inert = false;
        $("showPanelBtn").hidden = true;
        const covered = window.innerHeight - panel.getBoundingClientRect().top;
        offY = covered / 2;
    } else if (!panel.classList.contains("collapsed")) {
        offX = panel.getBoundingClientRect().right / 2;
    }
    document.documentElement.style.setProperty("--dock-shift", `${offX}px`);
    cam.offXTarget = offX * dpr;
    cam.offYTarget = offY * dpr;
}

function openHelp() {
    const d = $("helpDialog");
    if (!d.open) d.showModal();
}

function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
}

function initUI() {
    buildAttractorCards();
    buildPaletteSwatches();
    applyAccent();

    $("luckyBtn").addEventListener("click", lucky);
    $("resetParamsBtn").addEventListener("click", resetParams);
    $("trailsSwitch").addEventListener("click", toggleTrails);
    $("spinSwitch").addEventListener("click", toggleSpin);
    $("playBtn").addEventListener("click", togglePause);
    $("restartBtn").addEventListener("click", restartParticles);
    $("resetViewBtn").addEventListener("click", resetView);
    $("fullscreenBtn").addEventListener("click", toggleFullscreen);
    $("helpBtn").addEventListener("click", openHelp);
    $("helpClose").addEventListener("click", () => $("helpDialog").close());
    $("helpDialog").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $("collapseBtn").addEventListener("click", togglePanel);
    $("showPanelBtn").addEventListener("click", togglePanel);
    $("sheetToggle").addEventListener("click", () => { if (isPhone()) toggleSheet(); });

    $("particleCount").addEventListener("input", e => {
        const n = parseInt(e.target.value, 10);
        $("particleCountVal").textContent = n.toLocaleString("en-US");
        paintRange(e.target);
        setCount(n);
    });
    $("speed").addEventListener("input", e => {
        state.speed = parseFloat(e.target.value);
        $("speedVal").textContent = state.speed.toFixed(1) + "×";
        paintRange(e.target);
    });

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("lostpointercapture", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", resetView);
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => keysDown.clear());

    // Phones start with the sheet closed so the attractor has the screen.
    if (isPhone()) toggleSheet();

    new ResizeObserver(resize).observe(document.documentElement);
    new ResizeObserver(updateLayout).observe($("panel"));
}

function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.round(window.innerWidth * dpr));
    height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    updateLayout();
    dirty = true;
}

// Optional frame-rate readout: add ?fps to the URL.
const showFps = new URLSearchParams(location.search).has("fps");
let fpsFrames = 0, fpsLast = 0;
function fpsTick(now) {
    if (!showFps) return;
    fpsFrames++;
    if (now - fpsLast > 500) {
        $("fps").textContent = `${Math.round(fpsFrames * 1000 / (now - fpsLast))} fps · ${count} particles · ${gl ? (glr.hdr ? "WebGL2 HDR" : "WebGL2") : "Canvas 2D"} · ${Math.round(quality.scale * 100)}% res`;
        fpsFrames = 0;
        fpsLast = now;
    }
}

window.addEventListener("DOMContentLoaded", () => {
    canvas = $("canvas");
    if (!initGL()) ctx = canvas.getContext("2d", { alpha: false });
    if (showFps) $("fps").hidden = false;

    initUI();
    resize();
    applyAttractor(state.type);
    cam.offX = cam.offXTarget;
    cam.offY = cam.offYTarget;
    cam.lastInput = performance.now();
    requestAnimationFrame(frame);
});
