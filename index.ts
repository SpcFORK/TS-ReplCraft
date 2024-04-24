// const ReplCraft = require('./lib/replcraft.js');
// let client = new ReplCraft();
import RClient from './replcraft';
let client = new RClient();

(async () => {
  const { context } = await client.login(process.env.token);
  if (context) {
    context.setBlock(0, 0, 0, 'minecraft:cobblestone');
  }
})();