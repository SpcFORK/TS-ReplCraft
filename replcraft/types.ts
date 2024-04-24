/**
 *  A block string consisting of a resource location[0] and a list of
 *  comma-seperated block states in brackets.
 *
 *  [0] https://minecraft.fandom.com/wiki/Resource_location
 *  * e.g.
 *    - `minecraft:chest[facing=north,type=single,waterlogged=false]`
 *    - `minecraft:redstone_wire[east=side,north=none,power=5,south=up,west=none]`
 */
type Block = string;

/**
 * Represents errors specific to ReplCraft operations.
 */
interface CraftError {
  type:
    | "connection closed"
    | "unauthenticated"
    | "authentication failed"
    | "invalid operation"
    | "invalid structure"
    | "bad request"
    | "out of fuel"
    | "offline";
}

interface Entity {
  type: string;
  name: string;
  health?: number;
  max_health?: number;
  player_uuid?: string;
  x: number;
  y: number;
  z: number;
}

interface Item {
  index: number;
  type: string;
  amount: number;
}

/**
 * @param {number?} ContainerReference.x the x coordinate of the container this item is in
 * @param {number?} ContainerReference.y the y coordinate of the container this item is in
 * @param {number?} ContainerReference.z the z coordinate of the container this item is in
 * @param {boolean?} ContainerReference.structure when `true`, use structure inventory instead of a container
 */
interface ContainerReference {
  x?: number;
  y?: number;
  z?: number;
  structure?: boolean;
}

/**
 * @param {number} ItemReference.index the container slot this item is in
 */
interface ItemReference {
  index: number;
}

/**
 * @param {FuelInfoConnection[]} connections A list of all active connections for your player to all your structures.
 * @param {FuelInfoStrategy[]} strategies A list of strategies and how much fuel they have in reserve.
 * @param {Object.<string, FuelInfoAPICost>} apis A list of apis you can call and their base and adjusted fuel costs
 */
interface FuelInfo {
  connections: FuelInfoConnection[];
  strategies: FuelInfoStrategy[];
  apis: FuelInfoAPICost;
}

/**
 * @param {number} x the minimum x coordinate of the connection's structure
 * @param {number} y the minimum y coordinate of the connection's structure
 * @param {number} z the minimum z coordinate of the connection's structure
 * @param {string} structure A textual representation of the structure. The format is not fixed and subject to change.
 * @param {Object.<string, FuelInfoConnectionFuelUsage>} fuelUsage Fuel used by API route
 */
interface FuelInfoConnection {
  x: number;
  y: number;
  z: number;
  structure: string;
  fuelUsage: FuelInfoConnectionFuelUsage;
}

/**
 * @param {number} second the amount of fuel used in the past 1 second
 * @param {number} minute the amount of fuel used in the past 1 minute
 */
interface FuelInfoConnectionFuelUsage {
  second: number;
  minute: number;
}

/**
 * @param {string} name the name of the strategy
 * @param {string} strategy the type of strategy ("ratelimit", "item", "economy", "durability", etc.)
 * @param {number} spareFuel How much "spare" fuel this strategy has, which will be used before the strategy is activated to generate more. For `ratelimit`, this is always increasing up to a cap. For `item`, this is refilled when an item is burnt.
 * @param {number} userLimit How much fuel the strategy is allowed to use for this context, as set by `setFuelLimit`
 * @param {number} totalUsed How much fuel the strategy has generated for this context so far
 * @param {number} generatableEstimate An estimate of how much fuel can be generated
 */
interface FuelInfoStrategy {
  name: string;
  strategy: string;
  spareFuel: number;
  userLimit: number;
  totalUsed: number;
  generatableEstimate: number;
}

/**
 * @param {number} baseFuelCost How much this API costs normally
 * @param {number} fuelCost How much this API costs right now
 */
interface FuelInfoAPICost {
  baseFuelCost: number;
  fuelCost: number;
}

/**
 * A tuple of x, y, z coordinates.
 */
type XYZ = [number, number, number];

/**
 * Events emitted by the client.
 */
interface ClientEvents {
  /** Emitted when the connection is successfully opened. */
  open: () => void;
  /** Emitted when the connection is closed. */
  close: () => void;
  /**
   * Emitted when an error occurs.
   * @param error The error that occurred.
   */
  error: (error: CraftError) => void;
}

/**
 * Describes the details of a block update event.
 */
type BlockUpdateEvent = {
  /** The cause of the update. */
  cause:
    | "poll"
    | "burn"
    | "break"
    | "explode"
    | "fade"
    | "grow"
    | "ignite"
    | "piston_extend"
    | "piston_retract"
    | "place"
    | "fluid"
    | "decay"
    | "redstone";
  /** The new state of the block. */
  block: Block;
  /** The x coordinate of the block that changed. */
  x: number;
  /** The y coordinate of the block that changed. */
  y: number;
  /** The z coordinate of the block that changed. */
  z: number;
  /** The context ID this event was fired in. Will be re-fired on the appropriate StructureContext as well. */
  context: number;
};

/**
 * Describes the transaction event details.
 *
 * @param {string} query The text used in the /transact command, excluding the initial amount
 * @param {number} amount The amount of money being offered in the transaction
 * @param {string} player The username of the player using the /transact command
 * @param {string} player_uuid The uuid of the player using the /transact command
 * @param {TransactionControl} accept Accepts the transaction, depositing the money into your account
 * @param {TransactionControl} deny Denies the transaction, refunding the money
 * @param {number} context The context ID this event was fired in. Will be re-fired on the appropriate StructureContext as well.
 */
type TransactEvent = {
  query: string;
  amount: number;
  player: string;
  player_uuid: string;
  accept: TransactionControl;
  deny: TransactionControl;
  context: number;
};

/**
 * A control function for handling transactions.
 */
type TransactionControl = () => Promise<void>;

/**
 * Describes the outOfFuel event details.
 */
type OutOfFuelEvent = {
  /** The out of fuel error */
  error: CraftError; 
};