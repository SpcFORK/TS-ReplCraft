const { WebSocket } = require("ws");
const EventEmitter = require("events");

/**
 * @typedef {string} Block
 *  A block string consisting of a resource location[0] and a list of
 *  comma-seperated block states in brackets.
 *  [0] https://minecraft.fandom.com/wiki/Resource_location
 *  e.g.
 *  - `minecraft:chest[facing=north,type=single,waterlogged=false]`
 *  - `minecraft:redstone_wire[east=side,north=none,power=5,south=up,west=none]`
 */

/**
 * @typedef {Error} CraftError
 * @prop {String} CraftError.type
 *   one of "connection closed", "unauthenticated", "authentication failed", "invalid operation",
 *   "invalid structure", "bad request", "out of fuel" or "offline".
 */

/**
 * @typedef {Object} Entity
 * @prop {String} Entity.type
 * @prop {String} Entity.name
 * @prop {number?} Entity.health
 * @prop {number?} Entity.max_health
 * @prop {String?} Entity.player_uuid
 * @prop {number} Entity.x
 * @prop {number} Entity.y
 * @prop {number} Entity.z
 */

/**
 * @typedef {Object} Item
 * @prop {number} Item.index
 * @prop {String} Item.type
 * @prop {number} Item.amount
 */

/**
 * @typedef {Object} ContainerReference
 * @prop {number?} ContainerReference.x the x coordinate of the container this item is in
 * @prop {number?} ContainerReference.y the y coordinate of the container this item is in
 * @prop {number?} ContainerReference.z the z coordinate of the container this item is in
 * @prop {boolean?} ContainerReference.structure when `true`, use structure inventory instead of a container
 */

/**
 * @typedef {ContainerReference} ItemReference
 * @prop {number} ItemReference.index the container slot this item is in
 */

/**
 * @typedef {Object} FuelInfo
 * @prop {FuelInfoConnection[]} connections A list of all active connections for your player to all your structures.
 * @prop {FuelInfoStrategy[]} strategies A list of strategies and how much fuel they have in reserve.
 * @prop {Object.<string, FuelInfoAPICost>} apis A list of apis you can call and their base and adjusted fuel costs
 */

/**
 * @typedef {Object} FuelInfoConnection
 * @prop {number} x the minimum x coordinate of the connection's structure
 * @prop {number} y the minimum y coordinate of the connection's structure
 * @prop {number} z the minimum z coordinate of the connection's structure
 * @prop {string} structure A textual representation of the structure. The format is not fixed and subject to change.
 * @prop {Object.<string, FuelInfoConnectionFuelUsage>} fuelUsage Fuel used by API route
 */

/**
 * @typedef {Object} FuelInfoConnectionFuelUsage
 * @prop {number} second the amount of fuel used in the past 1 second
 * @prop {number} minute the amount of fuel used in the past 1 minute
 */

/**
 * @typedef {Object} FuelInfoStrategy
 * @prop {string} name the name of the strategy
 * @prop {string} strategy the type of strategy ("ratelimit", "item", "economy", "durability", etc.)
 * @prop {number} spareFuel How much "spare" fuel this strategy has, which will be used before the strategy is activated to generate more. For `ratelimit`, this is always increasing up to a cap. For `item`, this is refilled when an item is burnt.
 * @prop {number} userLimit How much fuel the strategy is allowed to use for this context, as set by `setFuelLimit`
 * @prop {number} totalUsed How much fuel the strategy has generated for this context so far
 * @prop {number} generatableEstimate An estimate of how much fuel can be generated
 */

/**
 * @typedef {Object} FuelInfoAPICost
 * @prop {number} baseFuelCost How much this API costs normally
 * @prop {number} fuelCost How much this API costs right now
 */

/** @typedef {number[]} XYZ A tuple of x, y, z coordinates */
/** @event open */
/** @event close */
/**
 * @event error
 * @param {CraftError} the error that occured
 */

/**
 * @event block update
 * @param {string} cause
 *   The cause of the update. One of: "poll" "burn" "break" "explode"
 *   "fade" "grow" "ignite" "piston_extend" "piston_retract" "place"
 *   "fluid" "decay" "redstone"
 * @param {Block} block the new state of the block
 * @param {number} x the x coordinate of the block that changed
 * @param {number} y the y coordinate of the block that changed
 * @param {number} z the z coordinate of the block that changed
 * @param {number} context the context ID this event was fired in.
 *   Will be re-fired on the appropriate StructureContext as well.
 */

/**
 * @event transact
 * @param {Object} transaction
 * @prop {String} transaction.query the text used in the /transact command, excluding the initial amount
 * @prop {number} transaction.amount The amount of money being offered in the transaction
 * @prop {String} transaction.player the username of the player using the /transact command
 * @prop {String} transaction.player_uuid the uuid of the player using the /transact command
 * @prop {TransactionControl} transaction.accept Accepts the transaction, depositing the money into your account
 * @prop {TransactionControl} transaction.deny Denies the transaction, refunding the money
 * @prop {number} transaction.context the context ID this event was fired in.
 *   Will be re-fired on the appropriate StructureContext as well.
 */

/**
 * @callback TransactionControl
 * @returns {Promise}
 */

/**
 * @event outOfFuel
 * @param {CraftError} error the out of fuel error
 */

/**
 * @event contextOpened
 * @param {StructureContext} context the newly created context
 * @param {String} cause why the context was created. One of
 *   `itemAttack`, `itemBreakBlock`, `itemInteractBlock`, `itemInteractAir`.
 */

/**
 * @event contextClosed
 * @param {number} context the ID of the closed context.
 *   Will be re-fired on the appropriate StructureContext as well.
 * @param {String} cause why the context was closed
 */

/**
 * A client for interacting with the ReplCraft server
 * @fires outOfFuel when a request encounters an out-of-fuel error
 * @fires transact when a player uses the /transact command inside the structure
 * @fires contextOpened when a new structure context is opened
 * @fires contextOpened when a structure context is closed
 */
class Client extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.host = null;
    this.handlers = null;
    this.nonce = 0;
    this.retryFuelErrors = false;
    this.retryQueue = [];
    this.__processRetryQueue();
  }

  /**
   * Starts a task to process the retry queue
   * @private
   */
  async __processRetryQueue() {
    while (true) {
      await new Promise((res) => this.once("__queueFilled", res));
      while (this.retryQueue.length > 0) {
        let { args, context, resolve, reject } = this.retryQueue.splice(
          0,
          1,
        )[0];
        this.request(args, context).then(resolve).catch(reject);
      }
    }
  }

  /**
   * Logs the client in and returns a promise that resolves once authenticated.
   * @param {String} token your api token
   * @return {Promise}
   * @throws {CraftError}
   * @fires open
   * @fires close
   * @fires error
   */
  async login(token) {
    if (this.ws && this.host != config.host) {
      let error = new Error(
        "Attempted to log in to different servers over the same websocket. Create a new client instead",
      );
      error.type = "connection closed";
      throw error;
    }
    token = token.replace(/\s*(http:\/\/)?\s*/, "");
    let config = JSON.parse(atob(token.split(".")[1]));
    if (!this.ws) {
      this.ws = new WebSocket("ws://" + config.host + "/gateway/v2", {});
      this.host = config.host;
      this.handlers = new Map();

      let heartbeat = null;

      this.ws.once("close", () => {
        this.emit("close");
        for (let [_nonce, handler] of this.handlers.entries()) {
          handler({
            ok: false,
            error: "connection closed",
            message: "connection closed",
          });
        }
        this.handlers = null;
        this.ws = null;
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
      });

      this.ws.on("message", (json) => {
        let msg = JSON.parse(json);
        if (this.handlers.has(msg.nonce)) {
          this.handlers.get(msg.nonce)(msg);
          this.handlers.delete(msg.nonce);
        }
        this.emit("__message", msg);
        switch (msg.type) {
          case "contextOpened":
            this.emit(
              "contextOpened",
              new StructureContext(this, msg.id),
              msg.cause,
            );
            break;

          case "contextClosed":
            this.emit("contextClosed", msg.id, msg.cause);
            break;

          case "block update":
            this.emit(
              "block update",
              msg.cause,
              msg.block,
              msg.x,
              msg.y,
              msg.z,
              msg.context,
            );
            break;

          case "transact":
            this.emit("transact", {
              query: msg.query,
              amount: msg.amount,
              player: msg.player,
              player_uuid: msg.player_uuid,
              context: msg.context,
              accept: () => {
                return this.request({
                  action: "respond",
                  context: msg.context,
                  queryNonce: msg.queryNonce,
                  accept: true,
                });
              },
              deny: () => {
                return this.request({
                  action: "respond",
                  context: msg.context,
                  queryNonce: msg.queryNonce,
                  accept: false,
                });
              },
            });
            break;
        }
      });

      await new Promise((res, rej) => {
        this.ws.once("open", res);
        this.ws.once("error", rej);
      });
      heartbeat = setInterval(
        () => this.request({ action: "heartbeat" }),
        10000,
      );
      this.ws.once("close", () => clearInterval(heartbeat));
      this.emit("open");
    }

    let res = await this.request({ action: "authenticate", token });
    return {
      scope: res.scope,
      context:
        res.context != null ? new StructureContext(this, res.context) : null,
    };
  }

  /**
   * Enables or disables automatic retries when out of fuel.
   * Note that requests will hang indefinitely until fuel is supplied.
   * You can monitor fuel status by listening to the "outOfFuel" event
   * @param {boolean} retry if retries should be enabled or disabled
   */
  retryOnFuelError(retry = true) {
    this.retryFuelErrors = retry;
  }

  /** Disconnects the client */
  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Makes a request to the server. You probably shouldn't use this directly.
   * @param {Object} args: the request to make
   * @param {StructureContext?} context: the context making this request
   * @return {Promise<Object>}
   * @throws {CraftError}
   */
  async request(args, context) {
    if (!this.ws) {
      let error = new Error("connection closed");
      error.type = "connection closed";
      throw error;
    }
    let nonce = (this.nonce++).toString();
    let request = { ...args, nonce, context: context?.id ?? undefined };
    this.emit("__request", request);
    this.ws.send(JSON.stringify(request));

    return await new Promise((res, rej) => {
      this.handlers.set(nonce, (response) => {
        if (!response.ok) {
          let error = new Error(response.error + ": " + response.message);
          error.type = response.error;
          if (response.error == "out of fuel") {
            this.emit("outOfFuel", error);
            context?.emit("outOfFuel", error);
          }
          if (response.error == "out of fuel" && this.retryFuelErrors) {
            setTimeout(() => {
              this.retryQueue.push({
                args,
                context,
                resolve: res,
                reject: rej,
              });
              this.emit("__queueFilled");
            }, 500);
          } else {
            rej(error);
          }
        } else {
          res(response);
        }
      });
    });
  }
}

/**
 * A context scoped to a single structure.
 *
 * @fires outOfFuel when a request from this context encounters an out-of-fuel error
 * @fires transact when a player uses the /transact command inside the structure associated with this context
 * @fires contextClosed when this context is closed, usually due to expiring or being invalidated.
 */
class StructureContext extends EventEmitter {
  constructor(client, contextId) {
    super();
    this.__client = client;
    this.__disposed = false;
    this.id = contextId;

    this.onBlockUpdate = function (cause, block, x, y, z, context) {
      if (context != contextId) return;
      this.emit("block update", cause, block, x, y, z, context);
    }.bind(this);
    this.__client.on("block update", this.onBlockUpdate);

    this.onTransact = function (arg) {
      if (arg.context != contextId) return;
      this.emit("transact", arg);
    }.bind(this);
    this.__client.on("transact", this.onTransact);

    this.onContextClosed = function (context, cause) {
      if (context != contextId) return;
      this.emit("contextClosed", context, cause);
      this.__dispose();
    }.bind(this);
    this.__client.on("contextClosed", this.onContextClosed);
  }

  __dispose() {
    this.__client.off("block update", this.onBlockUpdate);
    this.__client.off("transact", this.onTransact);
    this.__client.off("contextClosed", this.onContextClosed);
    this.__disposed = true;
  }

  /**
   * Makes a request to the server and includes this context's ID. You probably shouldn't use this directly.
   * @param {Object} args: the request to make
   * @return {Promise<Object>}
   * @throws {CraftError}
   */
  async request(args) {
    if (this.__disposed) {
      let error = new Error("This context has expired");
      error.type = "connection closed";
      throw error;
    }
    return await this.__client.request(args, this);
  }

  /**
   * Retrieves the inner size of the structure
   * @return {Promise<XYZA>}
   * @throws {CraftError}
   */
  getSize() {
    return this.request({ action: "get_size" }).then((r) => [r.x, r.y, r.z]);
  }

  /**
   * Retrieves the world coordinate location of the (0,0,0) inner coordinate
   * @return {Promise<XYZ>}
   * @throws {CraftError}
   */
  location() {
    return this.request({ action: "get_location" }).then((r) => [
      r.x,
      r.y,
      r.z,
    ]);
  }

  /**
   * Retrieves a block at the given structure-local coordinates.
   * Note that if obfuscation is enabled on the server, some blocks may be replaced
   * with replcraft-native types instead of the expected minecraft types.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise<Block>}
   * @throws {CraftError}
   */
  getBlock(x, y, z) {
    return this.request({ action: "get_block", x, y, z }).then((r) => r.block);
  }

  /**
   * Sets a block at the given structure-local coordinates. The block must be available
   * in the specified source chest or the structure inventory. Any block replaced by this call
   * is stored in the specified target chest or the structure inventory, or dropped in the
   * world if there's no space.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @param {Block} blockData
   * @param {ContainerReference?} source the container to take the block from. Defaults to structure inventory.
   * @param {ContainerReference?} target the container to put drops into. Defaults to structure inventory.
   * @return {Promise}
   * @throws {CraftError}
   */
  setBlock(x, y, z, blockData, source, target) {
    let {
      x: source_x,
      y: source_y,
      z: source_z,
      structure: source_structure,
    } = source || {};
    let {
      x: target_x,
      y: target_y,
      z: target_z,
      structure: target_structure,
    } = target || {};
    return this.request({
      action: "set_block",
      x,
      y,
      z,
      blockData,
      source_x,
      source_y,
      source_z,
      source_structure,
      target_x,
      target_y,
      target_z,
      target_structure,
    }).then(() => {});
  }

  /**
   * Retrieves the text of a sign at the given coordinates
   * @param {number} x the x coordinate of the sign (container relative)
   * @param {number} y the y coordinate of the sign (container relative)
   * @param {number} z the z coordinate of the sign (container relative)
   * @return {Promise<string[]>}
   * @throws {CraftError}
   */
  getSignText(x, y, z) {
    return this.request({ action: "get_sign_text", x, y, z }).then(
      (r) => r.lines,
    );
  }

  /**
   * Sets the text of a sign at the given coordinates
   * @param {number} x the x coordinate of the sign (container relative)
   * @param {number} y the y coordinate of the sign (container relative)
   * @param {number} z the z coordinate of the sign (container relative)
   * @param {string[]} lines the lines of text to set the sign to
   * @return {Promise}
   * @throws {CraftError}
   */
  setSignText(x, y, z, lines) {
    return this.request({ action: "set_sign_text", x, y, z, lines }).then(
      () => {},
    );
  }

  /**
   * Begins watching a block for updates.
   * Note that this isn't perfectly reliable and doesn't catch all possible updates.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  watch(x, y, z) {
    return this.request({ action: "watch", x, y, z }).then(() => {});
  }

  /**
   * Stops watching a block for updates
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise}
   * @throws {CraftError}
   */
  unwatch(x, y, z) {
    return this.request({ action: "unwatch", x, y, z }).then(() => {});
  }

  /**
   * Begins watching all blocks in the structure for updates.
   * Note that this isn't perfectly reliable and doesn't catch all possible updates.
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  watchAll() {
    return this.request({ action: "watch_all" }).then(() => {});
  }

  /**
   * Stops watching all blocks for updates.
   * @return {Promise}
   * @throws {CraftError}
   */
  unwatchAll() {
    return this.request({ action: "unwatch_all" }).then(() => {});
  }

  /**
   * Begins polling a block for updates.
   * Note that this catches all possible block updates, but only one block is polled per tick.
   * The more blocks you poll, the slower each individual block will be checked.
   * Additionally, if a block changes multiple times between polls, only the latest change
   * will be reported.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  poll(x, y, z) {
    return this.request({ action: "poll", x, y, z }).then(() => {});
  }

  /**
   * Stops watching a block for updates
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise}
   * @throws {CraftError}
   */
  unpoll(x, y, z) {
    return this.request({ action: "unpoll", x, y, z }).then(() => {});
  }

  /**
   * Begins polling all blocks in the structure for updates.
   * Updates will be very slow!
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  pollAll() {
    return this.request({ action: "poll_all" }).then(() => {});
  }

  /**
   * Stops polling all blocks in the structure.
   * @return {Promise}
   * @throws {CraftError}
   */
  unpollAll() {
    return this.request({ action: "unpoll_all" }).then(() => {});
  }

  /**
   * Gets all entities inside the region
   * @return {Promise<Entity[]>}
   * @throws {CraftError}
   */
  getEntities() {
    return this.request({ action: "get_entities" }).then((r) => r.entities);
  }

  /**
   * Gets all items from a container such as a chest or hopper
   * @param {ContainerReference} target the container to target
   * @return {Promise<Item[]>}
   * @throws {CraftError}
   */
  getInventory(target) {
    return this.request({ action: "get_inventory", ...target }).then(
      (r) => r.items,
    );
  }

  /**
   * Moves an item between containers
   * @param {ItemReference} source the item to move
   * @param {ItemReference|ContainerReference} target where to move the item
   * @param {number|null} amount the amount of items to move, or all if null
   * @return {Promise}
   * @throws {CraftError}
   */
  moveItem(source, target, amount = null) {
    let {
      x: source_x,
      y: source_y,
      z: source_z,
      structure: source_structure,
      index,
    } = source;
    let {
      x: target_x,
      y: target_y,
      z: target_z,
      structure: target_structure,
      index: target_index,
    } = target;
    return this.request({
      action: "move_item",
      amount,
      index,
      source_x,
      source_y,
      source_z,
      source_structure,
      target_index,
      target_x,
      target_y,
      target_z,
      target_structure,
    }).then(() => {});
  }

  /**
   * Gets a block's redstone power level
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise<number>}
   * @throws {CraftError}
   */
  getPowerLevel(x, y, z) {
    return this.request({ action: "get_power_level", x, y, z }).then(
      (r) => r.power,
    );
  }

  /**
   * Sends a message to a player. The player must be online and inside
   * the structure.
   * @param {string} target the name or UUID of the player
   * @param {string} message the message to send to the player
   * @return {Promise}
   * @throws {CraftError}
   */
  tell(target, message) {
    return this.request({ action: "tell", target, message }).then(() => {});
  }

  /**
   * Sends money to a player out of your own account
   * @param {string} target the name or UUID of the player
   * @param {number} amount the amount of money to send
   * @return {Promise}
   * @throws {CraftError}
   */
  pay(target, amount) {
    return this.request({ action: "pay", target, amount }).then(() => {});
  }

  /**
   * Crafts an item, which is then stored into the given container
   * @param {ContainerReference} target the output container
   * @param {ItemReference[]} ingredients the ingredients for the recipe
   * @return {Promise}
   * @throws {CraftError}
   */
  craft(target, ingredients) {
    return this.request({ action: "craft", ...target, ingredients }).then(
      () => {},
    );
  }

  /**
   * Obtains detailed fuel usage info for all connections
   * @return {Promise<FuelInfo>}
   * @throws {CraftError}
   */
  fuelInfo() {
    return this.request({ action: "fuelinfo" });
  }

  /**
   * Limits the amount of fuel that will be consumed from a given strategy for this context.
   * Calling this multiple times will remember the previous amount used, so calling it twice
   * with the same limit has no further effect. You must raise the limit to allow a strategy
   * that has reached it to consume more fuel.
   * @param {String} strategy the name of the strategy to set the limit for
   * @param {number} limit the maximum fuel that the strategy is allowed to generate
   * @returns {Promise}
   * @throws {CraftError}
   */
  setFuelLimit(strategy, limit) {
    return this.request({ action: "set_fuel_limit", strategy, limit });
  }

  /**
   * Closes the current context
   * @returns {Promise}
   */
  close() {
    return this.request({ action: "close" });
  }
}

module.exports = Client;
