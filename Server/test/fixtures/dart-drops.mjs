// Browser integration fixture: deterministic real pickup drops, no game-state injection.
// Loaded only by the test subprocess using --import; production never imports this file.
let draw = 0;
Math.random = () => draw++ % 2 === 0 ? 0.1 : 0.99;
