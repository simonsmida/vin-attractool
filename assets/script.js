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
        palette: "inferno",                // suggested palette
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
        palette: "orchid",                // suggested palette
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
        palette: "viridis",                // suggested palette
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
        palette: "glacier",                // suggested palette
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
        palette: "fluoro",                // suggested palette
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
        palette: "rainbow",                // suggested palette
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
        palette: "glacier",                // suggested palette
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
        palette: "orchid",                // suggested palette
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
        palette: "inferno",                // suggested palette
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
        palette: "viridis",                // suggested palette
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
        palette: "rainbow",                // suggested palette
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
    // Slow particles take the first colour, fast ones the last; trail tails
    // drift back towards the start. Stops are blended in OKLab. The
    // scientific maps follow matplotlib's perceptually uniform colormaps,
    // minus their near-black ends, which would vanish against the sky.
    inferno: { label: "Inferno", accent: "#fca50a", stops: ["#57106e", "#8a226a", "#bc3754", "#e45a31", "#f98e09", "#fbc228", "#f6e95c"] },
    glacier: { label: "Glacier", accent: "#3fb8ff", stops: ["#2a1fb8", "#2f4fff", "#1f8cff", "#00c2ff", "#3ff0ff", "#a8fff4"] },
    viridis: { label: "Viridis", accent: "#35b779", stops: ["#46327e", "#365c8d", "#277f8e", "#1fa187", "#4ac16d", "#a0da39", "#fde725"] },
    orchid: { label: "Orchid", accent: "#ff4fb8", stops: ["#4b0fa8", "#8a10d0", "#c21ad6", "#f02aa8", "#ff5a7e", "#ff9a6a"] },
    rainbow: { label: "Rainbow", accent: "#8ab4ff", oklch: { l: [0.64, 0.8], c: 0.22, h: [25, 320] } },
    fluoro: { label: "Fluorescent", accent: "#39ff88", stops: ["#ff00b8", "#b300ff", "#4a4dff", "#00e5ff", "#00ff9c", "#b6ff00"] }
};

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB <-> OKLab (Björn Ottosson's matrices).
const toLin = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toSrgb = c => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToOklab([r8, g8, b8]) {
    const r = toLin(r8), g = toLin(g8), b = toLin(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function oklabToRgb([L, A, B]) {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                 -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                 -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
    return rgb.map(c => Math.round(Math.max(0, Math.min(255, toSrgb(Math.max(0, c))))));
}

/* Returns PALETTE_SIZE colours as [r, g, b] in 0..255. */
function buildPalette(scheme) {
    const S = SCHEMES[scheme] || SCHEMES.inferno;
    const out = [];
    if (S.oklch) {
        const { l, c, h } = S.oklch;
        for (let i = 0; i < PALETTE_SIZE; i++) {
            const t = i / (PALETTE_SIZE - 1);
            const L = l[0] + (l[1] - l[0]) * t;
            const H = (h[0] + (h[1] - h[0]) * t) * Math.PI / 180;
            // Reduce chroma until the colour fits in sRGB, keeping its hue.
            let C = c, rgb;
            for (let k = 0; k < 12; k++) {
                const lab = [L, C * Math.cos(H), C * Math.sin(H)];
                rgb = oklabToRgb(lab);
                const back = rgbToOklab(rgb);
                if (Math.hypot(back[1] - lab[1], back[2] - lab[2]) < 0.01) break;
                C *= 0.9;
            }
            out.push(rgb);
        }
        return out;
    }
    const labs = S.stops.map(hex => rgbToOklab(hexToRgb(hex)));
    for (let i = 0; i < PALETTE_SIZE; i++) {
        const seg = i / (PALETTE_SIZE - 1) * (labs.length - 1);
        const k = Math.min(labs.length - 2, Math.floor(seg));
        const f = seg - k;
        out.push(oklabToRgb(labs[k].map((v, j) => v + (labs[k + 1][j] - v) * f)));
    }
    return out;
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

const MAX_PARTICLES = 20000;
const IS_TOUCH = window.matchMedia("(pointer: coarse)").matches;
// The slider's top: phones draw far fewer particles smoothly.
const COUNT_MAX = IS_TOUCH ? 8000 : MAX_PARTICLES;
// Particle-steps per frame before the integrator takes longer steps (up to
// 2x), so a huge swarm at high speed costs a bounded amount of time.
const STEP_BUDGET = IS_TOUCH ? 24000 : 60000;
let hScale = 1;
// Trail slots (particles × history length). Trails keep their full length
// up to a few thousand particles, so adding particles adds ink rather than
// trading trail length for count.
const HISTORY_BUDGET = window.matchMedia("(pointer: coarse)").matches ? 240000 : 480000;
const COUNT_MIN = 200;
const DEFAULT_SPEED = 0.25;        // slow enough to follow individual particles
/* The speed slider runs from a standstill to 2× on a power curve: most of
   its travel is for slow speeds, where differences are easy to see
   (half way is about 0.35×). */
const SPEED_MAX = 2, SPEED_CURVE = 2.5;
const speedFromSlider = v => SPEED_MAX * (v / 100) ** SPEED_CURVE;
const sliderFromSpeed = s => 100 * (s / SPEED_MAX) ** (1 / SPEED_CURVE);
const formatSpeed = s => String(+s.toFixed(2)) + "×";

/* The particle slider is logarithmic: equal moves multiply the count by the
   same factor (200 → 2,000 → 20,000), which matches how density is seen. */
function countFromSlider(v) {
    const n = COUNT_MIN * (COUNT_MAX / COUNT_MIN) ** (v / 100);
    const step = n < 1000 ? 50 : n < 5000 ? 100 : 500;
    return Math.round(n / step) * step;
}
function sliderFromCount(n) {
    return Math.round(100 * Math.log(n / COUNT_MIN) / Math.log(COUNT_MAX / COUNT_MIN));
}
/* Energy per particle. It falls more slowly than 1/count, so a dense swarm
   glows brighter and fuller than a sparse one (the tone map keeps it from
   clipping), while a few particles read as distinct, bright comets. */
function particleDensity(n) {
    return Math.min(1.9, Math.max(0.3, (2500 / Math.max(1, n)) ** 0.3));
}
const TRAIL_SECONDS = 1.5;            // real-time length of a trail at 1x

const state = {
    type: "lorenz",
    params: {},                       // live parameter values per attractor
    count: 800,
    speed: 0.25,
    paused: false,
    trails: true,
    trailFade: 1,                     // eases toward trails ? 1 : 0
    colorBy: "dye",                   // "dye" (carried by the flow) or "speed"
    dyeMix: 1,                        // eases toward colorBy === "dye" ? 1 : 0
    dyeClock: 0,                      // real-time seconds of simulated flow
    userPalette: false,               // the viewer picked a palette themselves
    spinRpm: 1.2,                     // auto-rotation speed, turns per minute
    lastSpinRpm: 1.2,
    scheme: "inferno",
    palette: buildPalette("inferno"),
    sceneFade: 1,                     // dips to 0 while switching attractors
    pendingType: null,
    morph: null,                      // { from, to, t } while Lucky morphs
    lastPreset: {},
    spot: 0,                          // spotlight on the butterfly cluster, 1 → 0
    tour: null                        // { t, step, spinBefore } during the cinematic tour
};
for (const key in ATTRACTORS) state.params[key] = { ...ATTRACTORS[key].params };

// Particles (structure of arrays).
const px = new Float64Array(MAX_PARTICLES);
const py = new Float64Array(MAX_PARTICLES);
const pz = new Float64Array(MAX_PARTICLES);
const pSpeed = new Float32Array(MAX_PARTICLES);
const pDye = new Float32Array(MAX_PARTICLES);   // dye concentration, 0..1
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
const THUMB_SAMPLES = 40000;     // dense enough that thumbnail strokes read as curves
const ref = {
    env: { w: 1, h: 1, mx: 0, my: 0 },
    pts: new Float64Array(REF_SAMPLES * 3),
    n: 0,
    center: [0, 0, 0],
    radius: 1,
    escape: 1e3,
    speedLo: 0,
    speedHi: 1,
    speedMax: 1,
    status: "ok"                      // ok | diverges | fixed
};

// Camera.
const cam = {
    // Screen footprint of the attractor while it turns (see envelope()).
    env: { w: 1, h: 1, mx: 0, my: 0 },
    q: [1, 0, 0, 0],                  // orientation quaternion [w, x, y, z]
    pendA: 0, pendB: 0,               // drag rotation not yet applied
    velA: 0, velB: 0,                 // angular velocity (rad/s) about screen axes
    spinRate: 0,                      // current idle spin (rad/s)
    zoom: 1,
    zoomTarget: 1,
    offX: 0, offY: 0,                 // centre of the free screen area (device px, y up)
    offXTarget: 0, offYTarget: 0,
    fitW: 1, fitH: 1,                 // size of the free area the attractor is fitted to
    fitWTarget: 1, fitHTarget: 1,
    panX: 0, panY: 0,                 // viewer's pan (device px, y up)
    panXTarget: 0, panYTarget: 0,
    center: [0, 0, 0],
    radius: 1,
    reset: null,                      // { t, from } while animating
    lastInput: 0                      // timestamp of the last user interaction
};

let canvas, ctx = null, dpr = 1, width = 0, height = 0;
// Dynamic resolution: the light buffer shrinks on slow GPUs and grows back
// when there is headroom, so motion stays fluid on any machine.
let dirty = true;
const k1 = new Float64Array(3), k2 = new Float64Array(3), k3 = new Float64Array(3), k4 = new Float64Array(3);

// --------------------------------------------------------------------------
// Integration
// --------------------------------------------------------------------------

/* Advance every particle by simulation time T using equal RK4 steps. */
/* Dye: each particle carries a colour. A plane through the attractor's
   centre turns slowly, and every particle that crosses it is repainted with
   the current paint colour, which itself drifts slowly through the palette.
   So a particle's colour records when it last crossed the plane (a turning
   Poincaré section): fresh colour enters at the plane, rides the flow, and
   chaos stretches and folds it into filaments. */
const DYE_CYCLE = 9;                  // seconds for the paint to sweep the palette and back
const DYE_LO = 0.22;                  // paint skips the palette's darkest end
const dyeAxis = new Float64Array(4);  // plane normal x, y, z; current paint
function updateDyeField() {
    const c = state.dyeClock;
    const th = 2 * Math.PI * c / 47, ph = 0.6 * Math.sin(2 * Math.PI * c / 71);
    dyeAxis[0] = Math.cos(th) * Math.cos(ph);
    dyeAxis[1] = Math.sin(th) * Math.cos(ph);
    dyeAxis[2] = Math.sin(ph);
    const f = (c / DYE_CYCLE) % 1;
    dyeAxis[3] = DYE_LO + (1 - DYE_LO) * (1 - Math.abs(2 * f - 1));
}
/* Signed distance to the paint plane, in attractor radii. */
function dyePlane(x, y, z) {
    const c = ref.center;
    return ((x - c[0]) * dyeAxis[0] + (y - c[1]) * dyeAxis[1] + (z - c[2]) * dyeAxis[2]) / ref.radius;
}
/* Starting colours: a gradient across the plane, so the full palette shows
   at once and then gets wound up by the flow. */
function dyeStart(x, y, z) {
    return Math.max(DYE_LO, Math.min(1, 0.6 + 0.6 * dyePlane(x, y, z)));
}
/* Alive: light follows the chaos itself. Each particle carries a tangent
   vector, a tiny separation from an imaginary twin, evolved with the flow's
   Jacobian. Its growth rate is the local Lyapunov exponent: how hard the
   flow is tearing neighbouring trajectories apart right here. Particles
   flare as they pass through the regions where the attractor stretches and
   folds (where its future is decided) and sink to embers where the flow
   coasts and contracts. Because the stretching zones are fixed in the
   attractor, every orbit brightens as it passes through them: the whole
   swarm pulses with its own dynamics, waves of light running along the
   streams. */
const tvx = new Float32Array(MAX_PARTICLES), tvy = new Float32Array(MAX_PARTICLES), tvz = new Float32Array(MAX_PARTICLES);
const pStretch = new Float32Array(MAX_PARTICLES);   // smoothed local stretching rate (1 / sim time)
const pFlash = new Uint8Array(MAX_PARTICLES);       // flare level 0..255 for the shaders
const pMark = new Float32Array(MAX_PARTICLES);      // butterfly cluster highlight, 1 → 0
// The butterfly source: releases a stream of marked particles (see butterfly()).
const emitter = { x: 0, y: 0, z: 0, left: 0, rate: 0, acc: 0, next: 0, stride: 1, nozzle: 0, glow: 0 };
const k5 = new Float64Array(3);
function initTangent(i) {
    let a, b, c, l;
    do { a = Math.random() - 0.5; b = Math.random() - 0.5; c = Math.random() - 0.5; l = Math.hypot(a, b, c); } while (l < 0.05);
    tvx[i] = a / l; tvy[i] = b / l; tvz[i] = c / l;
    pStretch[i] = 0;
}
/* Map stretching to flare against running percentiles of the swarm, so
   every attractor and parameter set uses the full range: roughly the lower
   half rests as embers and the most stretched few percent blaze. */
const glowSample = new Float32Array(512);
let glowLo = 0, glowHi = 0;
function updateGlow(dt) {
    if (count === 0) return;
    const m = Math.min(512, count);
    for (let k = 0; k < m; k++) glowSample[k] = pStretch[(Math.random() * count) | 0];
    const s = glowSample.subarray(0, m).sort();
    const lo = s[Math.floor(m * 0.4)], hi = s[Math.floor(m * 0.97)];
    const a = glowHi === 0 && glowLo === 0 ? 1 : 1 - Math.exp(-dt / 1.2);
    glowLo += (lo - glowLo) * a;
    glowHi += (hi - glowHi) * a;
    const inv = 1 / Math.max(1e-6, glowHi - glowLo);
    for (let i = 0; i < count; i++) {
        let f = (pStretch[i] - glowLo) * inv;
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        pFlash[i] = Math.round(255 * f * f * (3 - 2 * f));
    }
}

/* Palette coordinate of particle i: speed, dye, or a blend while switching. */
function colorT(i) {
    const span = ref.speedHi - ref.speedLo;
    let t = (Math.log(pSpeed[i] + 1e-9) - ref.speedLo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t + (pDye[i] - t) * state.dyeMix;
}

/* Palette coordinate and flash level packed for the history (see shader). */
function packedT(i) {
    return colorT(i) + 2 * pFlash[i] + 512 * Math.round(63 * pMark[i]);
}

function integrate(T) {
    const A = ATTRACTORS[state.type];
    const p = state.params[state.type];
    const f = A.deriv;
    const n = Math.max(1, Math.ceil(T / (A.h * hScale)));
    const h = T / n;
    const h2 = h / 2, h6 = h / 6;
    const esc2 = ref.escape * ref.escape;
    const vMax = ref.n > 0 ? 8 * Math.exp(ref.speedHi) : Infinity;
    const cx = ref.center[0], cy = ref.center[1], cz = ref.center[2];
    state.dyeClock += T / A.timeScale;
    updateDyeField();
    const paint = dyeAxis[3], n0 = dyeAxis[0], n1 = dyeAxis[1], n2 = dyeAxis[2];

    const eps = 1e-5 * ref.radius;
    const glow = state.dyeMix > 0;
    // Stretching is smoothed over about a third of a second of viewing.
    const relax = 1 - Math.exp(-T / (0.35 * A.timeScale));
    for (let i = 0; i < count; i++) {
        let x = px[i], y = py[i], z = pz[i];
        const px0 = x, py0 = y, pz0 = z;
        let vx = tvx[i], vy = tvy[i], vz = tvz[i];
        for (let s = 0; s < n; s++) {
            f(x, y, z, p, k1);
            if (glow) {
                // Tangent: v += h · J v, with J v by a forward difference.
                f(x + eps * vx, y + eps * vy, z + eps * vz, p, k5);
                vx += h * (k5[0] - k1[0]) / eps;
                vy += h * (k5[1] - k1[1]) / eps;
                vz += h * (k5[2] - k1[2]) / eps;
            }
            f(x + h2 * k1[0], y + h2 * k1[1], z + h2 * k1[2], p, k2);
            f(x + h2 * k2[0], y + h2 * k2[1], z + h2 * k2[2], p, k3);
            f(x + h * k3[0], y + h * k3[1], z + h * k3[2], p, k4);
            x += h6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
            y += h6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
            z += h6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        }
        const dx = x - cx, dy = y - cy, dz = z - cz;
        // Off the attractor (or non-finite, which fails both tests): far
        // outside its extent, or moving much faster than anything on it.
        if (!(dx * dx + dy * dy + dz * dz < esc2) || !(Math.hypot(k1[0], k1[1], k1[2]) < vMax)) {
            spawn(i);
            continue;
        }
        px[i] = x; py[i] = y; pz[i] = z;
        pSpeed[i] = Math.hypot(k1[0], k1[1], k1[2]);
        if (glow) {
            const g = Math.hypot(vx, vy, vz);
            if (g > 0 && Number.isFinite(g)) {
                pStretch[i] += (Math.log(g) / T - pStretch[i]) * relax;
                tvx[i] = vx / g; tvy[i] = vy / g; tvz[i] = vz / g;
            } else initTangent(i);
        }
        // Crossed the paint plane during this step: pick up the paint.
        const before = (px0 - cx) * n0 + (py0 - cy) * n1 + (pz0 - cz) * n2;
        const after = dx * n0 + dy * n1 + dz * n2;
        if ((before < 0) !== (after < 0)) pDye[i] = paint;
    }
}

/* Advance the simulation by T, committing history samples on schedule. */
function advance(T) {
    const eps = 1e-9;
    const A = ATTRACTORS[state.type];
    hScale = Math.min(2, Math.max(1, count * Math.ceil(T / A.h) / STEP_BUDGET));
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
function spawn(i, initial = false) {
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
    const f = ATTRACTORS[state.type].deriv;
    f(px[i], py[i], pz[i], state.params[state.type], k1);
    pSpeed[i] = Math.hypot(k1[0], k1[1], k1[2]);
    pDye[i] = initial ? dyeStart(px[i], py[i], pz[i]) : dyeAxis[3];
    initTangent(i);
    pFlash[i] = 0;
    pMark[i] = 0;
    resetHistory(i);
}

function spawnAll() {
    updateDyeField();
    glowLo = glowHi = 0;              // re-learn the flare range at once
    emitter.left = 0;                 // a new scene stops any butterfly stream
    emitter.glow = 0;
    for (let i = 0; i < count; i++) spawn(i, true);
    dirty = true;
}

/* Integrate one orbit for a long time to learn the attractor's shape. */
function computeReference() {
    const res = sampleOrbit(ATTRACTORS[state.type], state.params[state.type]);
    applyReference(res);
}

/* Long orbit after the transient: REF_SAMPLES points and their speeds, or
   null if every attempt escaped to infinity. */
function sampleOrbit(A, p, samples = REF_SAMPLES) {
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
        const stride = Math.max(1, Math.round((A.span || 200) / h / samples));
        const pts = new Float64Array(samples * 3);
        const speeds = new Float32Array(samples);
        for (let j = 0; j < samples; j++) {
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
    // Pivot on the middle of the attractor's extent (robust to the rarest
    // 0.1 % on each side), so lopsided shapes such as the Rössler spike are
    // framed whole and centred, whatever the rotation.
    const center = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
        const v = new Float64Array(REF_SAMPLES);
        for (let j = 0; j < REF_SAMPLES; j++) v[j] = pts[3 * j + d];
        v.sort();
        center[d] = 0.5 * (v[Math.floor(REF_SAMPLES * 0.001)] + v[Math.floor(REF_SAMPLES * 0.999)]);
    }
    const dist = new Float64Array(REF_SAMPLES);
    for (let j = 0; j < REF_SAMPLES; j++) {
        dist[j] = Math.hypot(pts[3 * j] - center[0], pts[3 * j + 1] - center[1], pts[3 * j + 2] - center[2]);
    }
    dist.sort();
    const radius = dist[Math.floor(REF_SAMPLES * 0.9995)];
    const s = speeds.slice().sort();

    ref.pts = pts;
    ref.n = REF_SAMPLES;
    ref.center = center;
    ref.status = radius < 1e-6 ? "fixed" : "ok";
    ref.radius = Math.max(radius, 1e-3);
    // Anything this far out has left the attractor; respawning it early
    // means no long stray streaks while it drifts away.
    ref.escape = ref.radius * 2;
    ref.env = envelope(pts, center, ref.radius);
    ref.speedLo = Math.log(s[Math.floor(REF_SAMPLES * 0.03)] + 1e-9);
    ref.speedHi = Math.log(s[Math.floor(REF_SAMPLES * 0.97)] + 1e-9);
    ref.speedMax = s[Math.floor(REF_SAMPLES * 0.995)];
    if (ref.speedHi - ref.speedLo < 1e-6) ref.speedHi = ref.speedLo + 1;
    if (hist.buf) updateHistoryInterval();
    updateStatus();
}

// --------------------------------------------------------------------------
// Particle count and history
// --------------------------------------------------------------------------

function setCount(n) {
    n = Math.max(0, Math.min(COUNT_MAX, n | 0));
    const old = count;
    count = n;
    allocHistory(old);
    for (let i = old; i < n; i++) spawn(i);
    dirty = true;
}

/* (Re)allocate the history for the current count. Existing trails are
   carried over, resampled by age if the history length changes, so moving
   the particle slider never makes trails snap or vanish. */
function allocHistory(keep = 0) {
    const n = Math.max(1, count);
    const old = hist.buf ? { buf: hist.buf, L: hist.L, stride: hist.stride, head: hist.head, interval: hist.interval } : null;
    // Lengths come in a few steps so most slider moves keep the same one.
    const L = Math.floor(HISTORY_BUDGET / n);
    hist.L = L >= 64 ? 64 : L >= 48 ? 48 : L >= 32 ? 32 : L >= 24 ? 24 : 16;
    hist.W = Math.min(n, 2048);
    hist.R = Math.ceil(n / hist.W);
    hist.stride = hist.W * hist.R;
    hist.buf = new Float32Array(hist.L * hist.stride * 4);
    hist.head = 0;
    hist.clock = 0;
    updateHistoryInterval();
    const m = old ? Math.min(keep, count) : 0;
    for (let a = 0; a < hist.L && m > 0; a++) {
        const ao = Math.min(old.L - 1, Math.round(a * hist.interval / old.interval));
        const from = ((old.head - ao + old.L) % old.L) * old.stride * 4;
        const to = ((hist.L - a) % hist.L) * hist.stride * 4;
        hist.buf.set(old.buf.subarray(from, from + m * 4), to);
    }
    hist.fullDirty = true;
    hist.dirtySlots.clear();
    if (gl) glResizeHistory();
}

/* Trails cover the same real time at every speed and particle count. */
function updateHistoryInterval() {
    const A = ATTRACTORS[state.type];
    // Samples stay closely spaced along the curve: at most ~1/8 of the
    // attractor's radius apart even for its fast particles. With fewer slots
    // (many particles) or faster flows the trail gets shorter in time
    // instead of coarser, so curves never turn into long straight chords.
    const fine = 0.15 * ref.radius / Math.max(1e-9, ref.speedMax);
    hist.interval = Math.min(TRAIL_SECONDS * A.timeScale / 63, fine);
    // Never let the sample clock run past the interval (it would integrate
    // backwards for a moment).
    hist.clock = Math.min(hist.clock, hist.interval);
}

/* Collapse particle i's history onto its current position, so a respawned
   particle never draws a streak from where it used to be. */
function resetHistory(i) {
    if (!hist.buf || i >= count) return;
    const step = hist.stride * 4;
    const w = packedT(i);
    for (let k = 0, o = i * 4; k < hist.L; k++, o += step) {
        hist.buf[o] = px[i];
        hist.buf[o + 1] = py[i];
        hist.buf[o + 2] = pz[i];
        hist.buf[o + 3] = w;
    }
    hist.fullDirty = true;
}

function writeSlot(slot) {
    const b = hist.buf;
    for (let i = 0, o = slot * hist.stride * 4; i < count; i++, o += 4) {
        b[o] = px[i];
        b[o + 1] = py[i];
        b[o + 2] = pz[i];
        b[o + 3] = packedT(i);
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
const FIT = 0.88;                      // share of the free area the attractor fills
function frameScale() {
    const w = Math.max(80, cam.fitW), h = Math.max(80, cam.fitH);
    return FIT * Math.min(w / (2 * cam.env.w), h / (2 * cam.env.h)) * cam.zoom;
}

/* The attractor's real silhouette on screen, not a bounding sphere: project
   the reference orbit from the default tilt at every turn of the turntable
   and take the extent of all of them. Fitting that box (and centring its
   middle) fills the free area as much as possible, and auto-rotation never
   pushes the attractor out of view or makes the framing breathe. World
   units at the focal plane; mx, my is how far the box's middle sits from
   the centre point, which the screen offset cancels. */
function envelope(pts, center, radius) {
    const n = pts.length / 3;
    if (!n) return { w: radius, h: radius, mx: 0, my: 0 };
    const tilt = ATTRACTORS[state.type].view[1];
    const D = 4.5 * radius, TURNS = 32, PICK = 1500;
    const step = Math.max(1, Math.floor(n / PICK));
    const xs = [], ys = [];
    for (let t = 0; t < TURNS; t++) {
        const M = mul3(quatToMat(viewQuat([2 * Math.PI * t / TURNS, tilt])), alignMatrix);
        for (let j = 0; j < n; j += step) {
            const x = pts[3 * j] - center[0], y = pts[3 * j + 1] - center[1], z = pts[3 * j + 2] - center[2];
            const vz = M[6] * x + M[7] * y + M[8] * z;
            const k = D / Math.max(D - vz, 0.05 * radius);
            xs.push((M[0] * x + M[1] * y + M[2] * z) * k);
            ys.push((M[3] * x + M[4] * y + M[5] * z) * k);
        }
    }
    const lo = a => a[Math.floor(a.length * 0.0005)], hi = a => a[Math.floor(a.length * 0.9995)];
    const fx = Float64Array.from(xs).sort(), fy = Float64Array.from(ys).sort();
    const x0 = lo(fx), x1 = hi(fx), y0 = lo(fy), y1 = hi(fy);
    const floor = 0.05 * radius;      // flat systems still get a sensible size
    return { w: Math.max(floor, (x1 - x0) / 2), h: Math.max(floor, (y1 - y0) / 2), mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
}

/* Where the attractor's centre sits on screen: the middle of the free area
   plus the viewer's pan (device px from the screen centre, y up). */
const screenOffX = () => cam.offX + cam.panX - frameScale() * cam.env.mx;
const screenOffY = () => cam.offY + cam.panY - frameScale() * cam.env.my;

// --------------------------------------------------------------------------
// WebGL 2 renderer
// --------------------------------------------------------------------------

let gl = null;
let glFailure = "";                   // why WebGL 2 was not used, for ?fps
let glr = null;

const GL_PROJECT = `
uniform highp sampler2D uPos;
uniform int uW, uR, uHead, uLen;
uniform mat3 uView;
uniform vec3 uCenter;
uniform float uFocal, uCamDist, uRadius;
uniform vec2 uHalf;
uniform vec2 uOffset;                 // screen offset in pixels
uniform float uTailCool;               // how far trail tails drift down the palette
uniform float uAlive;                 // 0..1 weight of the stretch flares
uniform float uSpot;                  // 0..1 while a butterfly cluster is in the spotlight
uniform vec3 uSpark;                  // butterfly colour: a complement of the palette
// History .w packs the palette coordinate c (0..1) and a flash level k
// (0..255) as c + 2k.
// A butterfly mark m (0..63) rides on top as + 512m.
float markOf(float w) { return floor(w / 512.0) / 63.0; }
float remOf(float w) { return w - 512.0 * floor(w / 512.0); }
float flashOf(float w) { return floor(remOf(w) * 0.5) / 255.0; }
float colorOf(float w) {
    float r = remOf(w);
    // A flash warms the hue a step up the palette; marked particles burn at its top.
    float c = min(1.0, r - 2.0 * floor(r * 0.5) + 0.3 * uAlive * flashOf(w));
    return mix(c, 1.0, markOf(w));
}
// Brightness of a particle: dim between flashes, bright at the peak.
// Marked particles glow white-hot while everything else dims around them.
float glowOf(float w) {
    float m = markOf(w);
    float f = flashOf(w);
    return mix(1.0, 0.72 + 1.15 * f, uAlive * (1.0 - m)) * (1.0 - 0.55 * uSpot * (1.0 - m)) * (1.0 + 0.9 * m);
}
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
// The hottest flares get a white core.
float coreOf(float w) { float f = flashOf(w); return 0.4 * uAlive * f * f * f; }
// Atmospheric depth: the far side recedes, slightly cooler and dimmer.
vec3 depthTint(vec3 c, float depth) {
    return c * mix(vec3(0.55, 0.62, 0.8), vec3(1.05), depth);
}
vec3 colorAt(float t) {
    t = clamp(t, 0.0, 1.0);
    float f = t * ${PALETTE_SIZE - 1}.0;
    int i0 = int(floor(f));
    int i1 = min(i0 + 1, ${PALETTE_SIZE - 1});
    return mix(uPalette[i0], uPalette[i1], fract(f));
}
`;

const TRAIL_SUB = 4;                  // curve pieces per history segment
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
// Catmull-Rom through samples spaced evenly in time: a C1 curve whose
// tangents are the particle's (finite-difference) velocity, so fast arcs
// stay round instead of turning into straight chords.
vec3 curve(vec3 p0, vec3 p1, vec3 p2, vec3 p3, float t) {
    float t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2.0 * p1) + (-p0 + p2) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}
void main() {
    int i = gl_InstanceID % uCount;
    int age = gl_InstanceID / uCount;              // segment from age to age + 1
    vec4 a = fetchSample(i, age);
    vec4 b = fetchSample(i, age + 1);
    vec3 p0 = age > 0 ? fetchSample(i, age - 1).xyz : 2.0 * a.xyz - b.xyz;
    vec3 p3 = age + 2 < uLen ? fetchSample(i, age + 2).xyz : 2.0 * b.xyz - a.xyz;

    float t = float(gl_VertexID >> 1) / ${TRAIL_SUB}.0;   // 0 at the newer end
    float side = float(gl_VertexID & 1) * 2.0 - 1.0;
    float depth, d2;
    vec2 sp = project(curve(p0, a.xyz, b.xyz, p3, t), depth);
    // Screen tangent from a nearby point on the same curve.
    float e = t < 0.5 ? 0.02 : -0.02;
    vec2 sq = project(curve(p0, a.xyz, b.xyz, p3, t + e), d2);
    vec2 d = (sq - sp) * sign(e);
    float len = length(d);
    vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-dir.y, dir.x);
    // A collapsed history (a particle that just respawned) draws nothing.
    float seg = distance(a.xyz, b.xyz);

    float u = (float(age) + t) / float(uLen - 1);  // 0 at the head, 1 at the tail

    // Comet streak: widest at the head, tapering to a hairline; the extra
    // margin leaves room for a one-pixel anti-aliased edge.
    float w = uWidth * mix(1.7, 0.3, sqrt(u)) * mix(0.8, 1.15, depth);
    float half_ = w * 0.5 + 1.0;
    gl_Position = vec4((sp + n * side * half_) / uHalf, 0.0, 1.0);

    vSide = side * half_;                          // distance from the centre line, px
    vHalf = w * 0.5;
    // .w holds the palette coordinate the particle had at that moment, so
    // the trail records its colour history. In speed mode the tail also
    // cools down the palette, like an ember leaving darker smoke behind.
    float mk = markOf(a.w);
    vColor = mix(colorAt(mix(colorOf(a.w), colorOf(b.w), t) * (1.0 - uTailCool * u)), uSpark, mk)
           * mix(glowOf(a.w), glowOf(b.w), t);
    vColor += vec3(mix(coreOf(a.w), coreOf(b.w), t) * (1.0 - u));
    // Stream particles: short comet tails, so the stream reads as sparks
    // in flight rather than one bright band.
    vColor *= mix(1.0, 0.75, mk);
    vColor = depthTint(vColor, depth);
    // Bright head, long soft decay that reaches exactly zero at the tail.
    float fade = exp(-mix(4.2, 16.0, mk) * u) * (1.0 - u * u);
    // Thin lines cover less than a pixel; keep their energy constant.
    float cover = min(1.0, w);
    vAlpha = uAlpha * fade * cover * mix(0.4, 1.0, depth) * (seg > 1e-7 * uRadius ? 1.0 : 0.0);
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
out float vSize;
void main() {
    vec4 p = fetchSample(gl_VertexID, 0);
    float depth;
    vec2 s = project(p.xyz, depth);
    gl_Position = vec4(s / uHalf, 0.0, 1.0);
    vColor = depthTint(mix(colorAt(colorOf(p.w)), uSpark, markOf(p.w)) * glowOf(p.w) + vec3(coreOf(p.w)), depth);
    vAlpha = uAlpha * mix(0.4, 1.0, depth);
    vSize = uSize * mix(0.8, 1.15, depth) * (1.0 + 0.12 * markOf(p.w));
    gl_PointSize = vSize + 2.0;                    // room for the AA edge
}`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vSize;
out vec4 outColor;
void main() {
    // Exact pixel coverage of a disc: sharp at any size.
    float r = length(gl_PointCoord - 0.5) * (vSize + 2.0);
    float a = vAlpha * clamp(vSize * 0.5 + 0.5 - r, 0.0, 1.0);
    if (a <= 0.0) discard;
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
    // One scene texel per screen pixel: no resampling, no blur.
    vec3 hdr = max(texelFetch(uScene, ivec2(gl_FragCoord.xy), 0).rgb, 0.0);
    // Hue-preserving tone map: compress the brightest channel and scale the
    // others with it, so overlapping trails get brighter, never white.
    float m = max(hdr.r, max(hdr.g, hdr.b));
    vec3 c = m > 1e-5 ? hdr * ((1.0 - exp(-m * uExposure)) / m) : vec3(0.0);
    // Dither away banding in the faint tails.
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    // A soft vignette draws the eye to the centre, as a lens would.
    vec2 res = vec2(textureSize(uScene, 0));
    vec2 q = (gl_FragCoord.xy - 0.5 * res) / max(res.x, res.y);
    c *= 1.0 - 0.32 * smoothstep(0.25, 0.75, length(q));
    c += (n - 0.5) * (0.6 / 255.0);
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
    if (!context) { glFailure = "no WebGL 2 context"; return false; }
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
        glFailure = String(err && err.message || err).slice(0, 120);
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
    gl.uniform2f(u.uOffset, screenOffX(), screenOffY());
    gl.uniform1f(u.uTailCool, 0.5 * (1 - state.dyeMix));
    gl.uniform1f(u.uAlive, state.dyeMix);
    gl.uniform1f(u.uSpot, state.spot);
    gl.uniform3fv(u.uSpark, sparkColor());
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
    const sw = width, sh = height;
    if (!glr.targets || glr.targets.scene.w !== sw || glr.targets.scene.h !== sh) glResizeTargets(sw, sh);
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
        const density = particleDensity(count);

        if (state.trailFade > 0 && hist.L > 1) {
            const t = glr.trail;
            gl.useProgram(t.prog);
            setSceneUniforms(t.u, M);
            gl.uniform1i(t.u.uCount, count);
            gl.uniform1f(t.u.uWidth, dpr * Math.min(1.5, Math.sqrt(cam.zoom)));
            gl.uniform1f(t.u.uAlpha, 0.9 * density * state.trailFade);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (TRAIL_SUB + 1), count * (hist.L - 1));
        }

        const p = glr.point;
        gl.useProgram(p.prog);
        setSceneUniforms(p.u, M);
        // Heads are larger when there are few of them.
        const head = 3.6 - 0.45 * Math.log2(Math.max(1, count / COUNT_MIN));
        gl.uniform1f(p.u.uSize, dpr * Math.min(3.6, Math.max(1.7, head)) * Math.min(1.6, Math.sqrt(cam.zoom)));
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
    const ox = width / 2 + screenOffX(), oy = height / 2 - screenOffY();
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
    const colorIndex = i => Math.round(colorT(i) * (PALETTE_SIZE - 1));

    ctx.globalCompositeOperation = "lighter";

    // Comet trails, like the WebGL ones: each trail is drawn in a few pieces
    // that thin and fade towards the tail. A subset of particles keeps the
    // CPU cost bounded; light energy is scaled so dense clouds never clip.
    const density = Math.min(1.4, particleDensity(count) * 0.8);
    if (state.trailFade > 0 && hist.L > 1) {
        const step = Math.max(1, Math.ceil(count / 1500));
        const b = hist.buf, stride = hist.stride * 4, L = hist.L;
        const pieces = 4, per = Math.ceil((L - 1) / pieces);
        const sx = new Float32Array(L), sy = new Float32Array(L);
        ctx.lineCap = "round";
        for (let i = 0; i < count; i += step) {
            ctx.strokeStyle = css[colorIndex(i)];
            for (let a = 0; a < L; a++) {
                const o = ((hist.head - a + L) % L) * stride + i * 4;
                [sx[a], sy[a]] = proj(b[o], b[o + 1], b[o + 2]);
            }
            for (let k = 0; k < pieces; k++) {
                const a0 = k * per, a1 = Math.min(L - 1, a0 + per);
                if (a0 >= a1) break;
                const u = (k + 0.5) / pieces;
                ctx.globalAlpha = 0.32 * density * Math.exp(-4.5 * u) * state.trailFade * state.sceneFade;
                ctx.lineWidth = dpr * (1.6 - 1.2 * Math.sqrt(u));
                ctx.beginPath();
                ctx.moveTo(sx[a0], sy[a0]);
                for (let a = a0 + 1; a <= a1; a++) ctx.lineTo(sx[a], sy[a]);
                ctx.stroke();
            }
        }
    }

    ctx.globalAlpha = Math.min(1, 0.55 * density + 0.15) * state.sceneFade;
    const size = 1.8 * dpr;
    let lastColor = -1;
    for (let i = 0; i < count; i++) {
        const c = colorIndex(i);
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
    updateTour(dt);

    if (!state.paused && state.speed > 0 && count > 0 && dt > 0 && !state.pendingType) {
        if (state.dyeMix > 0) updateGlow(dt);
        if (state.spot > 0) updateSpot(dt);
        updateAutoColor(dt);
        const ts = ATTRACTORS[state.type].timeScale;
        if (state.spot > 0) advanceStream(dt * ts);
        advance(dt * state.speed * ts);
        dirty = true;
    }

    if (moving || dirty) {
        render();
        updateSource();
        dirty = false;

    }
    fpsTick(now);
}


/* Trails and attractor switches fade instead of popping. */
function updateFades(dt) {
    let changed = false;
    const dyeTarget = state.colorBy === "dye" ? 1 : 0;
    if (state.dyeMix !== dyeTarget) {
        const step = dt / 0.9;
        state.dyeMix = dyeTarget > state.dyeMix ? Math.min(1, state.dyeMix + step) : Math.max(0, state.dyeMix - step);
        changed = true;
    }
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
        if ((ka || kb) && keysDown.has("Shift")) {
            const v = 0.6 * Math.min(width, height) * dt;
            panBy(-ka * v, kb * v, true);
            cam.lastInput = now;
        } else if (ka || kb) { rotateView(ka * rate * dt, kb * rate * dt); moving = true; cam.lastInput = now; }
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

    // Steady turntable rotation; it yields while the viewer is steering and
    // eases back in shortly after.
    const idle = (now - cam.lastInput) / 1000;
    const spinTarget = state.spinRpm > 0 && !pointer.dragging && !cam.reset && idle > 1.2 && Math.hypot(cam.velA, cam.velB) < 0.05 ? state.spinRpm * Math.PI / 30 : 0;
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
    if (Math.abs(cam.fitWTarget - cam.fitW) > 0.3 || Math.abs(cam.fitHTarget - cam.fitH) > 0.3) {
        cam.fitW += (cam.fitWTarget - cam.fitW) * oe;
        cam.fitH += (cam.fitHTarget - cam.fitH) * oe;
        moving = true;
    } else {
        cam.fitW = cam.fitWTarget;
        cam.fitH = cam.fitHTarget;
    }
    // Pan eases at the zoom's rate, so zooming toward the cursor stays put.
    if (Math.abs(cam.panXTarget - cam.panX) > 0.05 || Math.abs(cam.panYTarget - cam.panY) > 0.05) {
        const pe = 1 - Math.exp(-dt * 10);
        cam.panX += (cam.panXTarget - cam.panX) * pe;
        cam.panY += (cam.panYTarget - cam.panY) * pe;
        moving = true;
    } else {
        cam.panX = cam.panXTarget;
        cam.panY = cam.panYTarget;
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
    for (const key of ["w", "h", "mx", "my"]) {
        const d = ref.env[key] - cam.env[key];
        if (Math.abs(d) > ref.radius * 1e-4) { cam.env[key] += d * ease; moving = true; }
        else cam.env[key] = ref.env[key];
    }

    return moving;
}

function clampZoom(z) {
    return Math.max(0.25, Math.min(12, z));
}

function resetView() {
    cam.velA = cam.velB = cam.pendA = cam.pendB = 0;
    cam.reset = { t: 0, from: cam.q.slice() };
    cam.zoomTarget = 1;
    cam.panXTarget = cam.panYTarget = 0;
    cam.lastInput = performance.now();
}

/* Keep at least part of the attractor on screen however far it is moved. */
function clampPan(v, half) {
    const lim = half + 0.6 * frameScale() * cam.radius / cam.zoom * cam.zoomTarget;
    return Math.max(-lim, Math.min(lim, v));
}

/* Move the view by (dx, dy) device px, y up. Immediate follows the finger;
   otherwise it eases (keyboard, wheel). */
function panBy(dx, dy, immediate) {
    cam.panXTarget = clampPan(cam.panXTarget + dx, width / 2);
    cam.panYTarget = clampPan(cam.panYTarget + dy, height / 2);
    if (immediate) { cam.panX = cam.panXTarget; cam.panY = cam.panYTarget; }
}

/* Zoom by factor k about a screen point (CSS px from the viewport's
   top-left), so the spot under the cursor or fingers stays put. */
function zoomAt(k, clientX, clientY, immediate) {
    const z0 = cam.zoomTarget, z1 = clampZoom(z0 * k), s = z1 / z0;
    const px = clientX * dpr - width / 2, py = height / 2 - clientY * dpr;
    const ox = cam.offXTarget + cam.panXTarget, oy = cam.offYTarget + cam.panYTarget;
    cam.zoomTarget = z1;
    cam.panXTarget = clampPan(px - (px - ox) * s - cam.offXTarget, width / 2);
    cam.panYTarget = clampPan(py - (py - oy) * s - cam.offYTarget, height / 2);
    if (immediate) {
        cam.zoom = z1;
        cam.panX = cam.panXTarget;
        cam.panY = cam.panYTarget;
    }
}

// --------------------------------------------------------------------------
// Pointer input. Touch: one or two fingers rotate, two fingers also pinch
// to zoom, three fingers pan. Mouse: left drag rotates; right or middle
// drag, or Shift + left drag, pans.
// --------------------------------------------------------------------------

const pointer = {
    active: new Map(),               // pointerId -> {x, y}
    dragging: false,                 // rotating with one pointer
    panning: false,                  // panning with a mouse button
    lastX: 0, lastY: 0, lastMove: 0,
    // Multi-touch gesture: centroid and spread of the fingers down.
    n: 0, cx: 0, cy: 0, spread: 0,
    lastTap: 0,
    // A press that barely moves and lets go quickly is a tap (butterfly).
    tap: false, downX: 0, downY: 0, downT: 0
};
const ROTATE_PER_PX = 0.0055;

function noteInput() {
    cam.lastInput = performance.now();
}

function touchGesture() {
    let cx = 0, cy = 0;
    const pts = [...pointer.active.values()];
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length; cy /= pts.length;
    let spread = 0;
    for (const p of pts) spread += Math.hypot(p.x - cx, p.y - cy);
    return { n: pts.length, cx, cy, spread: spread / pts.length };
}

/* Start (or restart, when a finger is added or lifted) a multi-touch
   gesture from the current fingers, so nothing jumps. */
function beginGesture(t) {
    const g = touchGesture();
    pointer.n = g.n; pointer.cx = g.cx; pointer.cy = g.cy; pointer.spread = g.spread;
    pointer.lastMove = t;
}

function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointer.active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    noteInput();
    cam.reset = null;
    cam.velA = cam.velB = 0;              // grabbing stops any glide
    if (pointer.active.size === 1) {
        pointer.lastX = pointer.downX = e.clientX;
        pointer.lastY = pointer.downY = e.clientY;
        pointer.lastMove = pointer.downT = e.timeStamp;
        // In the tour, a tap on hidden controls only brings them back.
        pointer.tap = (e.pointerType !== "mouse" || e.button === 0) && !e.shiftKey && !document.body.classList.contains("ui-idle");
        const panButton = e.pointerType === "mouse" && (e.button === 1 || e.button === 2 || e.shiftKey);
        if (panButton) {
            e.preventDefault();
            pointer.panning = true;
            canvas.classList.add("panning");
        } else {
            pointer.dragging = true;
            canvas.classList.add("dragging");
        }
        if (e.pointerType === "touch") {
            if (e.timeStamp - pointer.lastTap < 300) { cancelTap(); resetView(); pointer.tap = false; }
            pointer.lastTap = e.timeStamp;
        }
    } else {
        pointer.tap = false;
        pointer.dragging = pointer.panning = false;
        canvas.classList.remove("panning");
        beginGesture(e.timeStamp);
    }
}

function onPointerMove(e) {
    if (!pointer.active.has(e.pointerId)) return;
    pointer.active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    noteInput();

    if (pointer.active.size >= 2) {
        const g = touchGesture();
        if (g.n !== pointer.n) { beginGesture(e.timeStamp); return; }
        const dx = g.cx - pointer.cx, dy = g.cy - pointer.cy;
        if (g.n === 2) {
            // Two fingers: move together to rotate, spread to zoom.
            cam.pendA += dx * ROTATE_PER_PX;
            cam.pendB += dy * ROTATE_PER_PX;
            if (pointer.spread > 0 && g.spread > 0) {
                cam.zoomTarget = clampZoom(cam.zoomTarget * g.spread / pointer.spread);
                cam.zoom = cam.zoomTarget;
            }
        } else {
            // Three or more fingers: pan, the content following the hand.
            panBy(dx * dpr, -dy * dpr, true);
        }
        pointer.cx = g.cx; pointer.cy = g.cy; pointer.spread = g.spread;
        pointer.lastMove = e.timeStamp;
        return;
    }
    if (pointer.tap && Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 6) pointer.tap = false;
    const dx = e.clientX - pointer.lastX, dy = e.clientY - pointer.lastY;
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    pointer.lastMove = e.timeStamp;
    if (pointer.panning) panBy(dx * dpr, -dy * dpr, true);
    else if (pointer.dragging) {
        cam.pendA += dx * ROTATE_PER_PX;
        cam.pendB += dy * ROTATE_PER_PX;
    }
}

function onPointerUp(e) {
    if (!pointer.active.has(e.pointerId)) return;
    pointer.active.delete(e.pointerId);
    const left = pointer.active.size;
    if (left === 0) {
        // Only glide if the pointer was still moving at release.
        if (!pointer.dragging || e.timeStamp - pointer.lastMove > 70) cam.velA = cam.velB = 0;
        const max = 6;
        cam.velA = Math.max(-max, Math.min(max, cam.velA));
        cam.velB = Math.max(-max, Math.min(max, cam.velB));
        pointer.dragging = pointer.panning = false;
        canvas.classList.remove("dragging", "panning");
        if (pointer.tap && e.type === "pointerup" && e.timeStamp - pointer.downT < 400) onTap(e.clientX, e.clientY);
        pointer.tap = false;
    } else if (left === 1) {
        // Back to one finger: keep rotating from it, without a jump.
        const [p] = pointer.active.values();
        pointer.dragging = true;
        pointer.lastX = p.x;
        pointer.lastY = p.y;
        pointer.lastMove = e.timeStamp;
        cam.velA = cam.velB = 0;
    } else {
        beginGesture(e.timeStamp);
    }
    noteInput();
}

/* Wheel: scrolling zooms toward the cursor, with a mouse wheel or a
   trackpad alike; a trackpad pinch (ctrl + wheel to the browser) zooms too.
   Shift + scroll pans. Dragging rotates. */
function onWheel(e) {
    e.preventDefault();
    noteInput();
    cam.reset = null;
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= height / dpr; dy *= height / dpr; }

    if (e.ctrlKey) {
        zoomAt(Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01), e.clientX, e.clientY, true);
        return;
    }
    if (e.shiftKey) {
        // Shift + scroll pans (browsers may already turn it into deltaX).
        if (dx === 0) { dx = dy; dy = 0; }
        panBy(-dx * dpr, dy * dpr, true);
    } else if (dy !== 0) {
        dy = Math.max(-200, Math.min(200, dy));
        zoomAt(Math.exp(-dy * 0.0015), e.clientX, e.clientY, false);
    }
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
    if (e.key === "Shift") { keysDown.add("Shift"); return; }

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
    } else if (e.key === "d" || e.key === "D") {
        discover();
    } else if (e.key === "v" || e.key === "V") {
        setTour(!state.tour);
    } else if (e.key === "Escape" && state.tour) {
        setTour(false);
    } else if (e.key === "h" || e.key === "H") {
        togglePanel();
    } else if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
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

function setColorBy(mode) {
    state.colorBy = mode;
    document.querySelectorAll("#colorBy [data-mode]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    dirty = true;
}

function toggleColorBy() {
    setColorBy(state.colorBy === "dye" ? "speed" : "dye");
    showToast(state.colorBy === "dye" ? "Colour: alive, pulsing in waves" : "Colour: particle speed");
}

function toggleTrails() {
    state.trails = !state.trails;
    setPressed("trailsSwitch", state.trails);
    dirty = true;
}

function toggleSpin() {
    setSpin(state.spinRpm > 0 ? 0 : state.lastSpinRpm || 1.2);
    showToast(state.spinRpm > 0 ? `Auto-rotate ${formatRpm(state.spinRpm)}` : "Auto-rotate off");
}

function formatRpm(rpm) {
    return rpm > 0 ? `${rpm.toFixed(1)} rpm` : "Off";
}

function setSpin(rpm) {
    state.spinRpm = rpm;
    if (rpm > 0) {
        state.lastSpinRpm = rpm;
        cam.lastInput = Math.min(cam.lastInput, performance.now() - 1200);
    }
    $("spinBtn").setAttribute("aria-pressed", String(rpm > 0));
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
    cam.env = { ...ref.env };
    cam.q = viewQuat(ATTRACTORS[type].view);
    cam.velA = cam.velB = cam.pendA = cam.pendB = 0;
    cam.reset = null;
    cam.zoom = cam.zoomTarget = 1;
    cam.panX = cam.panY = cam.panXTarget = cam.panYTarget = 0;
    applyRecommended(type);
    // Each attractor opens in the palette that suits it, until the viewer
    // picks one themselves.
    if (!state.userPalette && ATTRACTORS[type].palette) setScheme(ATTRACTORS[type].palette);
    if (count !== state.count) setCount(state.count);
    else updateHistoryInterval();
    spawnAll();
    markSelectedCard(type);
    $("sheetCurrent").textContent = ATTRACTORS[type].short || ATTRACTORS[type].name;
    buildEquations();
    buildParamControls();
}

/* Each attractor opens with the particle count that renders it best, at the default speed
   speed (its time scale is already tuned per attractor). */
function applyRecommended(type) {
    const n = recommendedCount(type);
    state.speed = DEFAULT_SPEED;
    state.count = n;
    setRange("speed", sliderFromSpeed(DEFAULT_SPEED));
    $("speedVal").textContent = formatSpeed(DEFAULT_SPEED);
    setRange("particleCount", sliderFromCount(n));
    $("particleCountVal").textContent = n.toLocaleString("en-US");
}

/* Phones and tablets get fewer particles: the same look at a frame rate
   their GPUs can hold. */
function recommendedCount(type) {
    // Fewer particles leave dark space between the streaks, so each comet
    // reads on its own instead of merging into a solid surface.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    const n = ATTRACTORS[type].count * (touch ? 0.15 : 0.2);
    return Math.max(300, Math.round(n / 50) * 50);
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
    if (state.type === "discovered") { discover(); return; }
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

function makeCard(type) {
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
    // The default orbit, sampled once, is redrawn when the palette changes.
    thumbs[type] = { canvas: card.querySelector("canvas"), orbit: sampleOrbit(A, A.params, THUMB_SAMPLES) };
    return card;
}

function buildAttractorCards() {
    const grid = $("attractorGrid");
    for (const type of Object.keys(ATTRACTORS)) grid.appendChild(makeCard(type));
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
        grid.querySelector(`[data-type="${next}"]`).focus({ preventScroll: true });
    });
    grid.addEventListener("scroll", updateCardFades, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(sizeCardList).observe(grid);
    drawThumbs();
    sizeCardList();
}

function markSelectedCard(type) {
    document.querySelectorAll(".att-card").forEach(c => {
        const on = c.dataset.type === type;
        c.setAttribute("aria-checked", String(on));
        c.tabIndex = on ? 0 : -1;
        if (on) revealCard(c);
    });
}

/* Scroll the card list (only the list, never the panel) so card c is fully
   visible, clear of the edge fades. */
function revealCard(c) {
    const grid = $("attractorGrid");
    const g = grid.getBoundingClientRect(), r = c.getBoundingClientRect();
    if (isPhone()) {
        const m = 24;
        if (r.left < g.left + m) grid.scrollBy({ left: r.left - g.left - m, behavior: "smooth" });
        else if (r.right > g.right - m) grid.scrollBy({ left: r.right - g.right + m, behavior: "smooth" });
    } else {
        const m = 30;
        if (r.top < g.top + m) grid.scrollBy({ top: r.top - g.top - m, behavior: "smooth" });
        else if (r.bottom > g.bottom - m) grid.scrollBy({ top: r.bottom - g.bottom + m, behavior: "smooth" });
    }
}

/* Desktop: the list shows up to three full rows and a glimpse of the fourth,
   which fades out; fades appear at whichever edge has more cards beyond it. */
function sizeCardList() {
    const grid = $("attractorGrid"), card = grid.querySelector(".att-card");
    if (!card) return;
    if (isPhone()) {
        grid.style.maxHeight = "";
        grid.style.minHeight = "";
    } else {
        const rowH = card.getBoundingClientRect().height, gap = 8;
        grid.style.maxHeight = `${Math.round(3 * rowH + 2 * gap + 0.42 * rowH + 6)}px`;
        // On short screens the list gives up height first, so the rest of
        // the panel fits without scrolling; it never drops below about a row.
        grid.style.minHeight = `${Math.round(1.35 * rowH + 6)}px`;
    }
    updateCardFades();
}

function updateCardFades() {
    const grid = $("attractorGrid");
    const phone = isPhone();
    const pos = phone ? grid.scrollLeft : grid.scrollTop;
    const max = phone ? grid.scrollWidth - grid.clientWidth : grid.scrollHeight - grid.clientHeight;
    grid.classList.toggle("fade-start", pos > 2);
    grid.classList.toggle("fade-end", pos < max - 2);
}

function drawThumbs() {
    for (const type in thumbs) drawThumb(type);
}

function drawThumb(type) {
    {
        const { canvas: c, orbit } = thumbs[type];
        const A = ATTRACTORS[type];
        const r = window.devicePixelRatio > 1 ? 2 : 1;
        const w = c.clientWidth || 140, h = c.clientHeight || 88;
        c.width = Math.round(w * r);
        c.height = Math.round(h * r);
        const g = c.getContext("2d");
        g.fillStyle = "#04050a";
        g.fillRect(0, 0, c.width, c.height);
        if (!orbit) return;

        const M = mul3(quatToMat(viewQuat(A.view)), alignUp(A.up));
        const n = orbit.speeds.length, xs = new Float32Array(n), ys = new Float32Array(n);
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
        const pal = buildPalette(A.palette || state.scheme);
        const sLo = Math.log(sorted[Math.floor(n * 0.03)] + 1e-9), sHi = Math.log(sorted[Math.floor(n * 0.97)] + 1e-9);

        // Thin additive strokes: dense regions glow, sparse ones stay fine.
        // Points closer than ~0.6 px are merged and consecutive points of
        // the same colour share one path, so joins are smooth and round.
        g.globalCompositeOperation = "lighter";
        g.lineWidth = 0.55 * r;
        g.lineJoin = g.lineCap = "round";
        const bucket = j => {
            const t = Math.max(0, Math.min(1, (Math.log(speeds[j] + 1e-9) - sLo) / (sHi - sLo || 1)));
            return Math.round(t * (PALETTE_SIZE - 1));
        };
        const minStep = 0.6 * r;
        let cur = bucket(0), px = ox + xs[0] * k, py = oy + ys[0] * k;
        const begin = () => {
            const col = pal[cur];
            g.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.2)`;
            g.beginPath();
            g.moveTo(px, py);
        };
        begin();
        for (let j = 1; j < n; j++) {
            const qx = ox + xs[j] * k, qy = oy + ys[j] * k;
            if (Math.abs(qx - px) + Math.abs(qy - py) < minStep && j < n - 1) continue;
            g.lineTo(qx, qy);
            px = qx; py = qy;
            const b = bucket(j);
            if (b !== cur) { g.stroke(); cur = b; begin(); }
        }
        g.stroke();
        g.globalCompositeOperation = "source-over";
    }
}

// ---- Palette swatches -----------------------------------------------------

/* Auto colour (the default): the palette drifts by itself, holding each one
   for a while and then melting into the next through OKLab, so the swarm is
   never the same colour for long. Picking a swatch fixes that palette. */
const AUTO_HOLD = 16, AUTO_FADE = 7;  // seconds
const autoColor = { on: true, clock: 0, from: "inferno", to: "inferno" };
const labCache = {};
function paletteLab(name) {
    return labCache[name] ||= buildPalette(name).map(rgbToOklab);
}
function nextScheme(name) {
    const names = Object.keys(SCHEMES);
    return names[(names.indexOf(name) + 1) % names.length];
}
function startAutoColor(name) {
    autoColor.from = name;
    autoColor.to = nextScheme(name);
    autoColor.clock = 0;
}
function updateAutoColor(dt) {
    if (!autoColor.on) return;
    autoColor.clock += dt;
    const c = autoColor.clock - AUTO_HOLD;
    if (c <= 0) return;
    const t = Math.min(1, c / AUTO_FADE), e = t * t * (3 - 2 * t);
    // Blend in OKLCh along the shorter way round the hue circle: straight
    // OKLab blends of opposite hues pass through grey.
    const A = paletteLab(autoColor.from), B = paletteLab(autoColor.to);
    state.palette = A.map((a, i) => {
        const b = B[i];
        const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
        const ha = Math.atan2(a[2], a[1]), hb = Math.atan2(b[2], b[1]);
        let dh = hb - ha;
        dh -= 2 * Math.PI * Math.round(dh / (2 * Math.PI));
        const L = a[0] + (b[0] - a[0]) * e, C = ca + (cb - ca) * e, H = ha + dh * e;
        return oklabToRgb([L, C * Math.cos(H), C * Math.sin(H)]);
    });
    // The interface accent follows once the new palette dominates.
    if (e > 0.5 && state.scheme !== autoColor.to) { state.scheme = autoColor.to; applyAccent(); }
    dirty = true;
    if (t >= 1) startAutoColor(autoColor.to);
}

function markSwatches() {
    document.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-checked",
        String(b.dataset.scheme === "auto" ? autoColor.on : !autoColor.on && b.dataset.scheme === state.scheme)));
}

function buildPaletteSwatches() {
    const row = $("paletteRow");
    const auto = document.createElement("button");
    auto.type = "button";
    auto.className = "swatch swatch-auto";
    auto.setAttribute("role", "radio");
    auto.setAttribute("aria-label", "Auto: colours drift by themselves");
    auto.title = "Auto: colours drift by themselves";
    auto.dataset.scheme = "auto";
    auto.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M12 3.5c.5 3.9 1.8 5.4 5.6 6-3.8.6-5.1 2.1-5.6 6-.5-3.9-1.8-5.4-5.6-6 3.8-.6 5.1-2.1 5.6-6Z" /></svg>';
    auto.addEventListener("click", () => {
        state.userPalette = false;
        autoColor.on = true;
        startAutoColor(state.scheme);
        markSwatches();
    });
    row.appendChild(auto);
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
        b.addEventListener("click", () => { state.userPalette = true; autoColor.on = false; setScheme(name); });
        row.appendChild(b);
    }
}

function setScheme(name) {
    state.scheme = name;
    state.palette = buildPalette(name);
    if (autoColor.on) startAutoColor(name);
    markSwatches();
    applyAccent();
    dirty = true;
}

/* The interface accent follows the palette. */
function applyAccent() {
    const hex = (SCHEMES[state.scheme] || SCHEMES.inferno).accent;
    const [r, g, b] = hexToRgb(hex);
    const root = document.documentElement.style;
    root.setProperty("--accent", hex);
    root.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.18)`);
}

// ---- Folded dock (phones, sheet open) ----------------------------------------

let dockTimer = 0;
function setDockOpen(open, delay = 0) {
    clearTimeout(dockTimer);
    const apply = () => {
        document.body.classList.toggle("dock-open", open);
        $("dockMore").setAttribute("aria-expanded", String(open));
        if (open) dockTimer = setTimeout(() => setDockOpen(false), 5000);
    };
    if (delay) dockTimer = setTimeout(apply, delay); else apply();
}

// ---- Butterfly effect -------------------------------------------------------

let tapTimer = 0;
let butterflyHinted = false;

function cancelTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
}

/* A tap waits a moment so a double-click or double-tap (reset view) can
   cancel it. In the tour, the first tap only brings the controls back. */
function onTap(x, y) {
    cancelTap();
    tapTimer = setTimeout(() => { tapTimer = 0; butterfly(x, y); }, 260);
}

/* Project a world point to CSS pixels (and its view depth). */
function toScreen(X, Y, Z, M = viewMatrix()) {
    const [ccx, ccy, ccz] = cam.center;
    const r = cam.radius, camDist = 4.5 * r, focal = frameScale() * camDist;
    const x = X - ccx, y = Y - ccy, z = Z - ccz;
    const vx = M[0] * x + M[1] * y + M[2] * z;
    const vy = M[3] * x + M[4] * y + M[5] * z;
    const vz = M[6] * x + M[7] * y + M[8] * z;
    const w = focal / Math.max(camDist - vz, r * 0.05);
    return [(width / 2 + screenOffX() + vx * w) / dpr, (height / 2 - screenOffY() - vy * w) / dpr, vz];
}

/* The butterfly effect as a fountain: the tapped point on the attractor
   becomes a source that releases a stream of particles, each starting a
   hair away from the last. They leave as one bright stream, follow the
   same path for a while, then chaos fans the stream out and folds it over
   the whole attractor. Particles are released one by one in simulation
   time, so they are spaced along the flow instead of piled into a blob. */

function butterfly(clientX, clientY) {
    if (count === 0 || ref.n === 0 || state.pendingType) return;
    const M = viewMatrix();
    const r = cam.radius;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < ref.n; j++) {
        const [sx, sy, vz] = toScreen(ref.pts[3 * j], ref.pts[3 * j + 1], ref.pts[3 * j + 2], M);
        const dx = sx - clientX, dy = sy - clientY;
        // Prefer the nearer of overlapping strands.
        const d = dx * dx + dy * dy - vz / r * 40;
        if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) return;
    const A = ATTRACTORS[state.type];
    // Few enough to stay separate sparks; each one a spark-width apart.
    const n = Math.min(count, 140);
    emitter.x = ref.pts[3 * best];
    emitter.y = ref.pts[3 * best + 1];
    emitter.z = ref.pts[3 * best + 2];
    emitter.left = n;
    // One spark per ~3% of the attractor's size of travel at a typical
    // speed, so the stream is a string of beads, never a solid line.
    const vTyp = Math.exp(0.5 * (ref.speedLo + ref.speedHi));
    emitter.rate = vTyp / (0.03 * ref.radius);
    emitter.acc = 0;
    // Reuse particles spread over the whole cloud, so no region empties.
    emitter.stride = Math.max(1, Math.floor(count / n));
    emitter.next = (Math.random() * emitter.stride) | 0;
    emitter.nozzle = ref.radius * 0.09;
    emitter.glow = 1;
    state.spot = Math.max(state.spot, 0.001);
    state.spotAge = 0;
    dirty = true;
    ripple(clientX, clientY);
    if (!butterflyHinted) {
        butterflyHinted = true;
        showToast("Butterfly effect: nearby starts, torn apart by chaos");
    }
}

/* The stream keeps a lively pace even when the attractor is slowed right
   down: chaos needs a few time units to tear it apart, which would take
   minutes at 0.25x. The spotlit sparks run at least at STREAM_PACE while the
   dimmed rest keeps the chosen speed; speed 0 still freezes everything. */
const STREAM_PACE = 0.8;
function advanceStream(dtTs) {
    const speed = state.speed;
    const pace = Math.max(speed, STREAM_PACE);
    if (emitter.left > 0) emitStream(dtTs * pace);
    const extra = dtTs * (pace - speed);
    if (extra <= 0) return;
    const A = ATTRACTORS[state.type], p = state.params[state.type];
    for (let i = 0; i < count; i++) {
        if (pMark[i] <= 0) continue;
        stepParticle(i, extra, A, p);
        A.deriv(px[i], py[i], pz[i], p, k1);
        pSpeed[i] = Math.hypot(k1[0], k1[1], k1[2]);
    }
}

/* The stream's colour: the palette's opposite hue, light and saturated, so
   it stands out against the attractor yet belongs with it. Cached per
   palette. */
let sparkFor = null, spark = new Float32Array([1, 1, 1]);
function sparkColor() {
    if (sparkFor === state.palette) return spark;
    sparkFor = state.palette;
    let a = 0, b = 0;
    for (const c of state.palette) { const lab = rgbToOklab(c); a += lab[1]; b += lab[2]; }
    a /= state.palette.length; b /= state.palette.length;
    const C = Math.hypot(a, b);
    let rgb;
    if (C < 0.03) rgb = [255, 244, 228];          // many hues at once: warm white
    else {
        // Opposite hue, nudged 20 degrees so it reads as a designed accent.
        const H = Math.atan2(b, a) + Math.PI + 0.35;
        let L = 0.86, Cc = 0.17;
        for (let k = 0; k < 10; k++) {
            rgb = oklabToRgb([L, Cc * Math.cos(H), Cc * Math.sin(H)]);
            const back = rgbToOklab(rgb);
            if (Math.hypot(back[1] - Cc * Math.cos(H), back[2] - Cc * Math.sin(H)) < 0.01) break;
            Cc *= 0.88;
        }
    }
    spark = new Float32Array(rgb.map(v => v / 255));
    return spark;
}

/* Release the particles due during the next stretch T of stream time. */
function emitStream(T) {
    const A = ATTRACTORS[state.type], p = state.params[state.type];
    emitter.acc += T * emitter.rate;
    while (emitter.acc >= 1 && emitter.left > 0) {
        emitter.acc -= 1;
        emitter.left--;
        const i = emitter.next % count;
        emitter.next += emitter.stride;
        // A soft nozzle: Gaussian-ish offsets, most starts very close.
        let ux, uy, uz;
        do { ux = 2 * Math.random() - 1; uy = 2 * Math.random() - 1; uz = 2 * Math.random() - 1; } while (ux * ux + uy * uy + uz * uz > 1);
        const k = emitter.nozzle * Math.cbrt(Math.random());   // even across the ball
        px[i] = emitter.x + ux * k;
        py[i] = emitter.y + uy * k;
        pz[i] = emitter.z + uz * k;
        // Released at a random moment within this chunk, not all at once.
        stepParticle(i, Math.random() * T, A, p);
        A.deriv(px[i], py[i], pz[i], p, k1);
        pSpeed[i] = Math.hypot(k1[0], k1[1], k1[2]);
        pDye[i] = 1;
        pMark[i] = 1;
        initTangent(i);
        resetHistory(i);
    }
}

function stepParticle(i, T, A, p) {
    if (T <= 0) return;
    const n = Math.max(1, Math.ceil(T / A.h)), h = T / n, h2 = h / 2, h6 = h / 6, f = A.deriv;
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
    px[i] = x; py[i] = y; pz[i] = z;
}

/* The stream stays lit for a while, then hands the stage back. The
   spotlight eases in so the rest of the attractor dims gently. */
const SPOT_HOLD = 20, SPOT_FADE = 8; // seconds: long enough to watch it spread
function updateSpot(dt) {
    state.spotAge += dt;
    const level = state.spotAge < SPOT_HOLD ? Math.min(1, state.spotAge / 0.6) : Math.max(0, 1 - (state.spotAge - SPOT_HOLD) / SPOT_FADE);
    state.spot = level;
    const mark = state.spotAge < SPOT_HOLD ? 1 : level;
    for (let i = 0; i < count; i++) if (pMark[i] > 0) pMark[i] = mark;
    if (emitter.left <= 0) emitter.glow = Math.max(0, emitter.glow - dt / 1.2);
}

/* A soft glowing source pinned to the tapped point while it releases. */
function updateSource() {
    const el = $("source");
    if (!el) return;
    if (emitter.glow <= 0 || state.spot <= 0) { if (!el.hidden) el.hidden = true; return; }
    const [sx, sy] = toScreen(emitter.x, emitter.y, emitter.z);
    el.hidden = false;
    el.style.transform = `translate(${sx}px, ${sy}px)`;
    el.style.opacity = String(emitter.glow);
}

function ripple(x, y) {
    const el = document.createElement("span");
    el.className = "ripple";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    $("ripples").appendChild(el);
    setTimeout(() => el.remove(), 1000);
}

// ---- Cinematic tour ---------------------------------------------------------

const TOUR_STEP = 24;                 // seconds per scene
let idleTimer = 0;

/* Controls fade away while the tour plays; any movement brings the dock back
   for a few seconds. */
function wakeUI() {
    document.body.classList.remove("ui-idle");
    clearTimeout(idleTimer);
    if (state.tour) idleTimer = setTimeout(() => document.body.classList.add("ui-idle"), 2600);
}

function setTour(on) {
    if (!!state.tour === on) return;
    if (on) {
        state.tour = { t: 0, step: 0, spinBefore: state.spinRpm };
        if (state.spinRpm === 0) setSpin(1.2);
        document.body.classList.add("cinema");
        showToast("Cinematic tour · Esc to leave");
    } else {
        setSpin(state.tour.spinBefore);
        state.tour = null;
        document.body.classList.remove("cinema", "ui-idle");
    }
    $("tourBtn").setAttribute("aria-pressed", String(on));
    wakeUI();
    updateLayout();
}

/* Every scene either morphs into one of the system's presets or moves on:
   to the next attractor, and now and then to a freshly discovered one. */
function updateTour(dt) {
    const T = state.tour;
    if (!T || state.paused || dt <= 0) return;
    T.t += dt;
    if (T.t < TOUR_STEP) return;
    T.t = 0;
    T.step++;
    const types = Object.keys(ATTRACTORS).filter(k => k !== "discovered");
    if (T.step % 6 === 5) { discover(); return; }
    if (T.step % 2 === 0 || ATTRACTORS[state.type].presets.length < 2) {
        const i = types.indexOf(state.type);
        setAttractor(types[(i + 1) % types.length]);
    } else {
        lucky();
    }
}

// ---- Discover: search the space of quadratic flows ---------------------------

/* Random sparse quadratic systems
       ẋ, ẏ, ż = Σ c · {1, x, y, z, x², y², z², xy, xz, yz}
   are integrated and kept only if they are bounded, dissipative and
   chaotic: largest Lyapunov exponent λ₁ > 0 and a Kaplan–Yorke dimension
   between 2.03 and 2.7 (a strange attractor, not a blob or a near-cycle).
   This is Sprott's method; about one random system in a few thousand
   qualifies, which takes a second or two. The search runs in a worker. */
function discoverySearch(budgetMs) {
    const t0 = Date.now();
    const f = (c, x, y, z, o) => {
        for (let e = 0; e < 3; e++) {
            const b = e * 10;
            o[e] = c[b] + c[b + 1] * x + c[b + 2] * y + c[b + 3] * z + c[b + 4] * x * x + c[b + 5] * y * y + c[b + 6] * z * z + c[b + 7] * x * y + c[b + 8] * x * z + c[b + 9] * y * z;
        }
    };
    const a1 = new Float64Array(3), a2 = new Float64Array(3), a3 = new Float64Array(3), a4 = new Float64Array(3);
    const rk4 = (c, s, h) => {
        const x = s[0], y = s[1], z = s[2];
        f(c, x, y, z, a1);
        f(c, x + h / 2 * a1[0], y + h / 2 * a1[1], z + h / 2 * a1[2], a2);
        f(c, x + h / 2 * a2[0], y + h / 2 * a2[1], z + h / 2 * a2[2], a3);
        f(c, x + h * a3[0], y + h * a3[1], z + h * a3[2], a4);
        for (let d = 0; d < 3; d++) s[d] += h / 6 * (a1[d] + 2 * a2[d] + 2 * a3[d] + a4[d]);
        return Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < 200;
    };
    const coef = () => {
        if (Math.random() < 0.5) return Math.random() < 0.5 ? 1 : -1;
        return Math.round((0.2 + Math.random() * 2.8) * (Math.random() < 0.5 ? -10 : 10)) / 10;
    };
    const USES = [[1, 4, 7, 8], [2, 5, 7, 9], [3, 6, 8, 9]];   // terms containing x, y, z
    while (Date.now() - t0 < budgetMs) {
        const c = new Float64Array(30);
        const k = 5 + Math.floor(Math.random() * 4);
        for (let m = 0; m < k; m++) c[Math.floor(Math.random() * 30)] = coef();
        let ok = true;
        for (let e = 0; e < 3 && ok; e++) ok = c.subarray(e * 10, e * 10 + 10).some(v => v !== 0);
        // Every variable must drive some other equation (no decoupled parts).
        for (let v = 0; v < 3 && ok; v++) ok = [0, 1, 2].some(e => e !== v && USES[v].some(t => c[e * 10 + t] !== 0));
        if (!ok) continue;

        const h = 0.02, s = [0.1 * (Math.random() - 0.5), 0.1 * (Math.random() - 0.5), 0.1 * (Math.random() - 0.5)];
        let bounded = true;
        for (let i = 0; i < 3000 && bounded; i++) bounded = rk4(c, s, h);
        if (!bounded) continue;
        const d0 = 1e-8, q = [s[0] + d0, s[1], s[2]];
        let sum = 0, div = 0;
        const N = 25000, pts = [], vs = [];
        for (let i = 0; i < N && bounded; i++) {
            bounded = rk4(c, s, h) && rk4(c, q, h);
            const dx = q[0] - s[0], dy = q[1] - s[1], dz = q[2] - s[2];
            const d = Math.hypot(dx, dy, dz) || 1e-300;
            sum += Math.log(d / d0);
            q[0] = s[0] + dx * d0 / d; q[1] = s[1] + dy * d0 / d; q[2] = s[2] + dz * d0 / d;
            const [x, y, z] = s;
            div += c[1] + 2 * c[4] * x + c[7] * y + c[8] * z + c[12] + 2 * c[15] * y + c[17] * x + c[19] * z + c[23] + 2 * c[26] * z + c[28] * x + c[29] * y;
            if (i % 10 === 0) { pts.push(s.slice()); f(c, x, y, z, a1); vs.push(Math.hypot(a1[0], a1[1], a1[2])); }
            if (i === 3000 && sum < 0) bounded = false;
        }
        if (!bounded) continue;
        const le = sum / (N * h);
        div /= N;
        if (!(div < 0) || le < 0.03) continue;
        const D = 2 + le / Math.abs(div - le);
        if (D < 2.03 || D > 2.7) continue;
        vs.sort((u, v) => u - v);
        const vmed = vs[vs.length >> 1];
        if (vmed < 1e-3) continue;
        const mean = [0, 0, 0];
        for (const p of pts) for (let d = 0; d < 3; d++) mean[d] += p[d] / pts.length;
        const dist = pts.map(p => Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])).sort((u, v) => u - v);
        const r = dist[Math.floor(dist.length * 0.99)];
        const tc = r / vmed;
        if (le * tc < 0.06 || le * tc > 2.5) continue;
        // Not flat: the orbit's covariance must have real thickness.
        const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (const p of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (p[i] - mean[i]) * (p[j] - mean[j]) / pts.length;
        const det = C[0][0] * (C[1][1] * C[2][2] - C[1][2] * C[2][1]) - C[0][1] * (C[1][0] * C[2][2] - C[1][2] * C[2][0]) + C[0][2] * (C[1][0] * C[2][1] - C[1][1] * C[2][0]);
        if (det / (C[0][0] + C[1][1] + C[2][2]) ** 3 < 2e-5) continue;
        return { c: Array.from(c), s: s.slice(), le, D, tc, pts: pts.filter((_, i) => i % 4 === 0) };
    }
    return null;
}

const discovery = { worker: null, queue: [], pending: false, waiting: false, failed: false, last: "" };

function startDiscoveryWorker() {
    if (discovery.worker || discovery.failed) return;
    try {
        const src = `const discoverySearch = ${discoverySearch.toString()};
onmessage = () => { let r = null; while (!r) r = discoverySearch(4000); postMessage(r); };`;
        discovery.worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        discovery.worker.onmessage = e => onDiscovered(e.data);
        discovery.worker.onerror = () => { discovery.failed = true; discovery.worker = null; discovery.pending = false; refillDiscoveries(); };
    } catch (err) {
        discovery.failed = true;
    }
}

/* Keep one or two systems ready so Discover feels instant. */
function refillDiscoveries() {
    if (discovery.pending || discovery.queue.length >= 2) return;
    discovery.pending = true;
    startDiscoveryWorker();
    if (discovery.worker) { discovery.worker.postMessage("find"); return; }
    // No worker: search in short slices on the main thread.
    const slice = () => {
        const r = discoverySearch(25);
        if (r) onDiscovered(r); else setTimeout(slice, 16);
    };
    setTimeout(slice, 0);
}

function onDiscovered(sys) {
    discovery.pending = false;
    discovery.queue.push(sys);
    if (discovery.waiting) { discovery.waiting = false; discover(); }
    refillDiscoveries();
}

function setDiscoverBusy(on) {
    const b = $("discoverBtn");
    b.classList.toggle("busy", on);
    b.querySelector(".chip-text").textContent = on ? "Searching…" : "Discover";
}

function discover() {
    const sys = discovery.queue.shift();
    if (!sys) {
        discovery.waiting = true;
        setDiscoverBusy(true);
        refillDiscoveries();
        return;
    }
    setDiscoverBusy(false);
    refillDiscoveries();
    installDiscovered(sys);
}

const MONO = ["", "x", "y", "z", "x^2", "y^2", "z^2", "xy", "xz", "yz"];
const MONO_NAME = ["const", "x", "y", "z", "x²", "y²", "z²", "xy", "xz", "yz"];
const COEF_SYMS = "abcdefghkmnpqrsuvw";

function installDiscovered(sys) {
    const terms = [];
    sys.c.forEach((v, idx) => { if (v !== 0) terms.push({ e: Math.floor(idx / 10), t: idx % 10, v }); });
    const params = {}, ranges = {}, meta = {};
    terms.forEach((term, n) => {
        const key = COEF_SYMS[n];
        term.key = key;
        params[key] = term.v;
        const w = Math.max(0.5, Math.abs(term.v) * 0.5);
        ranges[key] = { min: +(term.v - w).toFixed(2), max: +(term.v + w).toFixed(2), step: 0.01 };
        meta[key] = { sym: key, name: `${["ẋ", "ẏ", "ż"][term.e]} · ${MONO_NAME[term.t]}` };
    });
    const eq = [0, 1, 2].map(e => [["ẋ", "ẏ", "ż"][e],
        terms.filter(t => t.e === e).map(t => `{${t.key}}${MONO[t.t]}`).join(" + ")]);
    const mono = new Float64Array(10);
    let deriv = (x, y, z, p, out) => {
        mono[0] = 1; mono[1] = x; mono[2] = y; mono[3] = z;
        mono[4] = x * x; mono[5] = y * y; mono[6] = z * z;
        mono[7] = x * y; mono[8] = x * z; mono[9] = y * z;
        out[0] = out[1] = out[2] = 0;
        for (let k = 0; k < terms.length; k++) {
            const t = terms[k];
            out[t.e] += p[t.key] * mono[t.t];
        }
    };
    // Straight-line code runs several times faster than the generic loop
    // above; keep the loop where a page policy forbids compiling.
    try {
        const MONO_JS = ["1", "x", "y", "z", "x * x", "y * y", "z * z", "x * y", "x * z", "y * z"];
        const body = [0, 1, 2].map(e => `out[${e}] = ${terms.filter(t => t.e === e)
            .map(t => `p.${t.key} * ${MONO_JS[t.t]}`).join(" + ") || "0"};`).join("\n");
        const fast = new Function("x", "y", "z", "p", "out", body);
        const probe = [0, 0, 0], ref0 = [0, 0, 0], pp = params;
        fast(0.3, -0.7, 1.1, pp, probe);
        deriv(0.3, -0.7, 1.1, pp, ref0);
        if (probe.every((v, i) => Math.abs(v - ref0[i]) < 1e-9)) deriv = fast;
    } catch (e) { /* keep the loop */ }
    // Name it after its coefficients, so the same system keeps its name.
    let hash = 2166136261;
    for (const ch of sys.c.join(",")) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
    const code = (hash >>> 0).toString(36).toUpperCase().slice(-4);
    // The view that shows the most of it: largest projected spread.
    let view = [-0.6, 0.3], up = [0, 0, 1], bestArea = -1;
    for (const u of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        for (let turn = 0; turn < Math.PI; turn += Math.PI / 8) {
            const M = mul3(quatToMat(viewQuat([turn, 0.3])), alignUp(u));
            let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
            for (const [x, y, z] of sys.pts) {
                const X = M[0] * x + M[1] * y + M[2] * z, Y = M[3] * x + M[4] * y + M[5] * z;
                sx += X; sy += Y; sxx += X * X; syy += Y * Y; sxy += X * Y;
            }
            const n = sys.pts.length, vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2, cxy = sxy / n - sx * sy / n / n;
            const area = vx * vy - cxy * cxy;
            if (area > bestArea) { bestArea = area; view = [turn, 0.3]; up = u; }
        }
    }
    const schemes = Object.keys(SCHEMES).filter(k => k !== discovery.last);
    const palette = schemes[Math.floor(Math.random() * schemes.length)];
    discovery.last = palette;
    const tc = sys.tc;
    ATTRACTORS.discovered = {
        name: `Specimen ${code}`,
        short: `Specimen ${code}`,
        palette, params, ranges, meta, eq,
        presets: [{ name: "As found", params: { ...params } }],
        note: `Found just now in a random search · λ₁ ≈ ${(sys.le * tc).toFixed(2)} per orbit · dimension ≈ ${sys.D.toFixed(2)}`,
        count: 3000,
        h: Math.min(0.03, Math.max(0.002, 0.015 * tc)),
        timeScale: 1.4 * tc,
        span: 400 * tc,
        transient: 10 * tc,
        up, view,
        seed: sys.s,
        deriv
    };
    state.params.discovered = { ...params };
    state.lastPreset.discovered = null;

    const grid = $("attractorGrid");
    const old = grid.querySelector('[data-type="discovered"]');
    const card = makeCard("discovered");
    card.classList.add("fresh");
    if (old) old.replaceWith(card); else grid.prepend(card);
    drawThumb("discovered");
    sizeCardList();

    state.morph = null;
    state.pendingType = "discovered";
    markSelectedCard("discovered");
    showToast(`New attractor · Specimen ${code}`);
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

/* Phone bottom sheet: open and close with a slide, by tap or by swipe. */
const SHEET_EASE = "transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)";
function setSheet(open, fromY = null) {
    const panel = $("panel");
    if (open === !panel.classList.contains("sheet-closed") && fromY === null) return;
    const head = panel.querySelector(".panel-head").getBoundingClientRect().height;
    if (open) {
        // Open at once, then slide up from where the sheet stands now.
        const closedOffset = fromY ?? 0;
        panel.classList.remove("sheet-closed");
        const travel = panel.getBoundingClientRect().height - head;
        panel.style.transition = "none";
        panel.style.transform = `translateY(${Math.max(0, travel + Math.min(0, closedOffset))}px)`;
        panel.getBoundingClientRect();
        panel.style.transition = SHEET_EASE;
        panel.style.transform = "";
        setTimeout(() => { if (!panel.style.transform) panel.style.transition = ""; }, 400);
    } else {
        // Slide down to the header, then fold the body away.
        const travel = panel.getBoundingClientRect().height - head;
        panel.style.transition = SHEET_EASE;
        panel.style.transform = `translateY(${travel}px)`;
        const done = () => {
            panel.removeEventListener("transitionend", done);
            clearTimeout(timer);
            panel.style.transition = "none";
            panel.classList.add("sheet-closed");
            panel.style.transform = "";
            requestAnimationFrame(() => { panel.style.transition = ""; });
            updateLayout();
        };
        const timer = setTimeout(done, 400);
        panel.addEventListener("transitionend", done);
    }
    $("sheetToggle").setAttribute("aria-expanded", String(open));
    updateLayout();
}

function toggleSheet() {
    setSheet($("panel").classList.contains("sheet-closed"));
}

/* Swipe the sheet by its header: it follows the finger, and a short or
   quick swipe down closes it, up opens it. A tap still toggles. */
function initSheetSwipe() {
    const panel = $("panel"), head = panel.querySelector(".panel-head");
    let start = null, swiped = false;
    head.addEventListener("pointerdown", e => {
        if (!isPhone() || e.button > 0 || e.target.closest("a, .icon-btn")) return;
        start = { y: e.clientY, t: e.timeStamp, id: e.pointerId, dy: 0, v: 0, last: e.clientY, lt: e.timeStamp };
        swiped = false;
    });
    head.addEventListener("pointermove", e => {
        if (!start || e.pointerId !== start.id) return;
        const dy = e.clientY - start.y;
        if (!swiped && Math.abs(dy) < 8) return;
        if (!swiped) { swiped = true; head.setPointerCapture(e.pointerId); }
        const dt = Math.max(1, e.timeStamp - start.lt);
        start.v = 0.7 * start.v + 0.3 * (e.clientY - start.last) / dt;
        start.last = e.clientY; start.lt = e.timeStamp; start.dy = dy;
        const open = !panel.classList.contains("sheet-closed");
        // Open: follow the finger down. Closed: a little give upward.
        const y = open ? Math.max(0, dy) * 1 + Math.min(0, dy) * 0.15 : Math.min(0, dy) * 0.35;
        panel.style.transition = "none";
        panel.style.transform = `translateY(${y}px)`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        const { dy, v } = start;
        start = null;
        if (!swiped) return;
        const open = !panel.classList.contains("sheet-closed");
        if (open && (dy > 70 || v > 0.45)) setSheet(false);
        else if (!open && (dy < -24 || v < -0.35)) setSheet(true, Math.min(0, dy) * 0.35);
        else {
            panel.style.transition = SHEET_EASE;
            panel.style.transform = "";
            setTimeout(() => { if (!panel.style.transform) panel.style.transition = ""; }, 400);
        }
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    // The click that ends a swipe must not toggle the sheet again.
    head.addEventListener("click", e => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
}

/* Keep the attractor centred in, and fitted to, the part of the screen the
   controls leave free: below the dock and above the sheet on phones, right
   of the panel and above the dock on wider screens. */
function updateLayout() {
    const panel = $("panel"), dock = document.querySelector(".dock");
    const W = window.innerWidth, H = window.innerHeight, m = 12;
    let left = 0, top = 0, right = W, bottom = H, shift = 0;
    if (document.body.classList.contains("cinema")) {
        // Full screen: the controls are hidden; keep a little air.
        document.body.classList.remove("sheet-open", "dock-open");
        top = 0.05 * H; bottom = 0.95 * H;
    } else if (isPhone()) {
        panel.classList.remove("collapsed");
        panel.inert = false;
        $("showPanelBtn").hidden = true;
        // With the sheet open the dock folds into a corner button, so the
        // attractor gets the whole height above the sheet.
        const open = !panel.classList.contains("sheet-closed");
        document.body.classList.toggle("sheet-open", open);
        if (!open) document.body.classList.remove("dock-open");
        top = open ? $("dockMore").getBoundingClientRect().top + 4 : dock ? dock.getBoundingClientRect().bottom + m : 0;
        // offsetTop ignores the slide transform: frame for where the sheet settles.
        bottom = panel.offsetTop - m;
    } else {
        document.body.classList.remove("sheet-open", "dock-open");
        if (!panel.classList.contains("collapsed")) {
            left = panel.getBoundingClientRect().right;
            shift = left / 2;
        }
        // The dock is short and centred; only trim the bottom margin a bit.
        if (dock) bottom = dock.getBoundingClientRect().top;
        top = H - bottom;
    }
    document.documentElement.style.setProperty("--dock-shift", `${shift}px`);
    const w = Math.max(60, right - left), h = Math.max(60, bottom - top);
    cam.offXTarget = ((left + right) / 2 - W / 2) * dpr;
    cam.offYTarget = (H / 2 - (top + bottom) / 2) * dpr;
    cam.fitWTarget = w * dpr;
    cam.fitHTarget = h * dpr;
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
    document.querySelectorAll("#colorBy [data-mode]").forEach(b => b.addEventListener("click", () => setColorBy(b.dataset.mode)));
    setSpin(state.spinRpm);
    $("spinBtn").addEventListener("click", toggleSpin);
    $("dockMore").addEventListener("click", () => setDockOpen(!document.body.classList.contains("dock-open")));
    // A dock action closes the folded dock again shortly after.
    $("dock").addEventListener("click", e => { if (e.target.closest(".dock-btn") && document.body.classList.contains("sheet-open")) setDockOpen(false, 900); });
    canvas.addEventListener("pointerdown", () => setDockOpen(false));
    // iPhone Safari has no fullscreen API: hide the button rather than offer a dead one.
    if (!document.fullscreenEnabled) $("fullscreenBtn").hidden = true;
    $("tourBtn").addEventListener("click", () => setTour(!state.tour));
    $("discoverBtn").addEventListener("click", discover);
    $("tuneBtn").addEventListener("click", () => {
        const open = $("tuneBtn").getAttribute("aria-expanded") !== "true";
        $("tuneBtn").setAttribute("aria-expanded", String(open));
        $("tunePanel").hidden = !open;
    });
    canvas.addEventListener("dblclick", cancelTap);
    for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) window.addEventListener(ev, wakeUI, { passive: true });
    $("speed").addEventListener("dblclick", e => {
        setRange(e.target, sliderFromSpeed(DEFAULT_SPEED));
        e.target.dispatchEvent(new Event("input"));
    });
    $("particleCount").addEventListener("dblclick", e => {
        setRange(e.target, sliderFromCount(recommendedCount(state.type)));
        e.target.dispatchEvent(new Event("input"));
    });
    $("playBtn").addEventListener("click", togglePause);
    $("restartBtn").addEventListener("click", restartParticles);
    $("resetViewBtn").addEventListener("click", resetView);
    $("fullscreenBtn").addEventListener("click", toggleFullscreen);
    $("collapseBtn").addEventListener("click", togglePanel);
    $("showPanelBtn").addEventListener("click", togglePanel);
    $("sheetToggle").addEventListener("click", () => { if (isPhone()) toggleSheet(); });
    initSheetSwipe();

    $("particleCount").addEventListener("input", e => {
        const n = countFromSlider(parseFloat(e.target.value));
        $("particleCountVal").textContent = n.toLocaleString("en-US");
        paintRange(e.target);
        setCount(n);
    });
    $("speed").addEventListener("input", e => {
        const v = speedFromSlider(parseFloat(e.target.value));
        // Snap to round values near them, so 1× and 0.5× are easy to hit.
        state.speed = v < 0.1 ? Math.round(v * 100) / 100 : Math.round(v * 20) / 20;
        if (v > 0 && state.speed === 0) state.speed = 0.01;
        $("speedVal").textContent = formatSpeed(state.speed);
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
    // Middle-button drag pans; stop the browser's autoscroll from starting.
    canvas.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
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
        $("fps").textContent = `${Math.round(fpsFrames * 1000 / (now - fpsLast))} fps · ${count} particles · ${gl ? (glr.hdr ? "WebGL2 HDR" : "WebGL2") : "Canvas 2D"} · ${width}×${height}px${glFailure ? " · " + glFailure : ""}`;
        fpsFrames = 0;
        fpsLast = now;
    }
}

window.addEventListener("DOMContentLoaded", () => {
    canvas = $("canvas");
    // ?2d forces the Canvas 2D fallback (for testing).
    if (new URLSearchParams(location.search).has("2d") || !initGL()) ctx = canvas.getContext("2d", { alpha: false });
    if (showFps) $("fps").hidden = false;

    initUI();
    resize();
    applyAttractor(state.type);
    cam.offX = cam.offXTarget;
    cam.offY = cam.offYTarget;
    cam.fitW = cam.fitWTarget;
    cam.fitH = cam.fitHTarget;
    // The sheet's height changes with its content (equations, sliders).
    if (window.ResizeObserver) new ResizeObserver(() => updateLayout()).observe($("panel"));
    cam.lastInput = performance.now();
    requestAnimationFrame(frame);
    // Have a discovery ready before anyone asks, once the page has settled.
    setTimeout(refillDiscoveries, 1000);
    // First visit: point out the butterfly effect once.
    setTimeout(() => {
        let seen = false;
        try { seen = localStorage.getItem("attractool-hint") === "1"; localStorage.setItem("attractool-hint", "1"); } catch (err) { /* private mode */ }
        if (!seen && !state.tour) showToast(`Tip: ${window.matchMedia("(pointer: coarse)").matches ? "tap" : "click"} the attractor to see the butterfly effect`);
    }, 5000);
});
