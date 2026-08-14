// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IConfidentialEngine} from "./interfaces/IConfidentialEngine.sol";
import {Epochs} from "./libraries/Epochs.sol";
import {GameTypes} from "./libraries/GameTypes.sol";

/**
 * The protocol's one storage layout, in one place.
 *
 * It lives in a base contract both `AegylaxGame` and `AegylaxLens` inherit,
 * because both run against the same storage: the game writes it, and the
 * read-only lens the game delegates unknown selectors to reads it. Sharing
 * the declaration is what makes that safe — one definition of the layout,
 * one slot constant, so the two can never drift apart the way two
 * hand-kept copies would. Declaring it inside a contract (rather than a
 * library) is also what lets the OpenZeppelin upgrade tooling see the
 * namespace and check an upgrade against it.
 *
 * The layout is ERC-7201 namespaced: everything hangs off one derived slot
 * instead of starting at slot 0. That keeps it clear of the inherited
 * OpenZeppelin storage and means an upgrade extends the struct without any
 * reserved-gap arithmetic — new fields land after the existing ones inside
 * a namespace nothing else can collide with.
 */
abstract contract AegylaxStorage {
    /// @custom:storage-location erc7201:aegylax.game.storage
    struct GameStorage {
        IConfidentialEngine engine;
        GameTypes.GameParams params;
        uint32 paramsVersion;
        /// Block the protocol's shared epoch grid is measured from.
        uint64 genesisBlock;
        uint256 lobbyNonce;
        uint256 protocolTreasury;
        // ---- stats ----
        uint64 totalLobbies;
        uint64 activeLobbies;
        uint64 totalAttacks;
        uint64 interceptedAttacks;
        uint64 missedAttacks;
        // ---- entities ----
        bytes32[] lobbyIds;
        mapping(bytes32 => GameTypes.Lobby) lobbies;
        mapping(bytes32 => GameTypes.LobbyConfig) lobbyConfigs;
        /// Parameters an operation is played under, frozen at creation.
        mapping(bytes32 => GameTypes.GameParams) lobbyParams;
        mapping(bytes32 => address[]) lobbyParticipants;
        mapping(bytes32 => mapping(address => GameTypes.Participant)) participants;
        /// attackId => the epoch's one attack. Keyed by epoch, not by operation.
        mapping(bytes32 => GameTypes.Attack) attacks;
        /**
         * The rules an epoch's attack is generated and resolved under,
         * snapshotted when the attack is minted.
         *
         * The world has to be one world. Grid, scale, interception radius
         * and interceptor speed all decide where the threat is and who
         * reached it — so reading them from each operation's frozen copy
         * would score two teams facing the identical attack against
         * different physics. The operation's own frozen params still govern
         * its own terms; anything about the *attack* comes from here.
         */
        mapping(uint32 => GameTypes.GameParams) epochParams;
        mapping(bytes32 => GameTypes.Trajectory) trajectories;
        /// lobbyId => that team's verdict. One attack, one outcome per team.
        mapping(bytes32 => GameTypes.Outcome) outcomes;
        /// lobbyId => that team's interception attempts, scored on their own.
        mapping(bytes32 => GameTypes.DefenseAttempt[]) attempts;
        /// attackId => whether the geometry has been published.
        mapping(bytes32 => bool) revealed;
        /// attackId => refund mode, when nobody ever revealed it.
        mapping(bytes32 => bool) expired;
        /// The read-only facet unknown selectors are delegated to.
        address lens;
        // ---- Global Defense Pool (appended; ERC-7201 namespace, so new
        //      fields land after the existing ones with no gap arithmetic) ----
        /**
         * Money from every COMPLETED round the threat won.
         *
         * When an operation is scored and nobody intercepted, its pool has no
         * winner to go to. Returning it to the creator is what the protocol
         * used to do and it is the wrong incentive — a bounty that comes back
         * on a miss is free to advertise — so it is held here instead and
         * played for later, by everybody, on the protocol's own operation.
         *
         * Deliberately *not* part of `protocolTreasury`. The treasury is
         * revenue and the owner may withdraw it; this is players' money in
         * escrow that the protocol has promised back to the game, and an
         * owner withdrawal must never be able to reach it.
         */
        uint256 globalDefensePool;
        /// epoch => the protocol's own operation for that epoch's draw, if opened.
        mapping(uint32 => bytes32) globalDefenseLobby;
        /**
         * How often the pool is played for, in epochs.
         *
         * A protocol-wide schedule rather than a rule an operation is played
         * under, which is why it is here and not in `GameParams` — see the
         * note at the end of that struct for the storage-layout half of the
         * reason, which is the half that would have cost real money.
         *
         * Zero disables the draw and leaves the pool accumulating. That is
         * also what an existing deployment reads immediately after an upgrade,
         * since `initialize` does not re-run — the owner turns the draw on
         * with `setGlobalDefenseInterval`, deliberately as its own decision
         * rather than something an upgrade switches on by surprise.
         */
        uint32 globalDefenseEpochInterval;
        /// hintHandle => the probe that produced it, until it is granted.
        mapping(bytes32 => GameTypes.ProbeFlight) probeFlights;
    }

    // keccak256(abi.encode(uint256(keccak256("aegylax.game.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant GAME_STORAGE_SLOT = 0xf954dfeb53523f1499e8d53a52dcb92d9048f8016a561a91aff54fbf4445ce00;

    function _gameStorage() internal pure returns (GameStorage storage $) {
        assembly {
            $.slot := GAME_STORAGE_SLOT
        }
    }

    // -----------------------------------------------------------------
    // Shared derivations — used by both the game and the lens, so that a
    // status or an epoch means exactly one thing protocol-wide.
    // -----------------------------------------------------------------

    /**
     * An attack's status as of *this block*.
     *
     * Launch and impact are facts about the block number, not transactions
     * somebody has to send, so the stored status only ever records what
     * needed a transaction (completion, resolution) and the rest is derived
     * on read. A client watching the chain sees the launch happen without
     * anybody having paid to announce it.
     */
    function _derivedStatus(GameTypes.Attack memory attack) internal view returns (GameTypes.AttackStatus) {
        if (attack.id == bytes32(0)) return GameTypes.AttackStatus.NONE;
        if (attack.status == GameTypes.AttackStatus.RESOLVED) return GameTypes.AttackStatus.RESOLVED;
        if (block.number >= attack.impactBlock) return GameTypes.AttackStatus.COMPLETED;
        if (block.number >= attack.launchBlock) return GameTypes.AttackStatus.LAUNCHED;
        return GameTypes.AttackStatus.PENDING;
    }

    /*
     * The epoch grid itself lives in `Epochs`, because `Lobbies` needs the
     * identical arithmetic to schedule a threat and two copies of consensus
     * math is a bug waiting for a maintenance window. These stay as thin
     * aliases so every call site in this contract and the lens reads the same
     * as it always did.
     */
    function _epochOf(uint64 blockNumber, uint32 epochBlocks, uint64 genesis) internal pure returns (uint32) {
        return Epochs.epochOf(blockNumber, epochBlocks, genesis);
    }

    function _epochStart(uint32 epochId, uint32 epochBlocks, uint64 genesis) internal pure returns (uint64) {
        return Epochs.epochStart(epochId, epochBlocks, genesis);
    }

    /// The epoch's attack id, derivable by anybody from the epoch number alone.
    function _epochAttackId(uint32 epochId) internal pure returns (bytes32) {
        return Epochs.attackId(epochId);
    }

    /**
     * How many attacks the protocol has actually flown, and how many of
     * those reached Earth.
     *
     * The counter in storage cannot answer this, and the difference is the
     * whole point. `$.totalAttacks` counts attacks that were *minted* — an
     * epoch only draws one when somebody starts an operation into it — so on
     * a protocol with seventeen operations to its name it reads seventeen,
     * while the sky has been crossed once per epoch since genesis whether or
     * not anybody was watching. An epoch nobody defended is not an epoch
     * nothing happened in; it is an epoch that was lost by default.
     *
     * So the figure is derived from the clock: one attack per epoch since
     * the protocol's own genesis block, which is the proxy's first
     * deployment. That makes it a fact about how long the protocol has
     * existed rather than about how popular it has been, it costs one
     * division to read, and there is no counter that can drift from it.
     *
     * The epoch in progress is excluded while its attack is still in the
     * air: a threat that has not landed has neither been intercepted nor
     * hit, and counting it would show an impact for an attack still in
     * flight. It is only excluded when it exists — an epoch nobody started
     * an operation into has already run its course.
     *
     * Impacts are then the remainder. Every attack that flew either was
     * stopped by some team or reached Earth, so tracking hits separately
     * would be storing a number that is already implied — and the stored
     * `missedAttacks` field, which nothing ever incremented, is exactly what
     * that mistake looked like.
     */
    function _attackTally(GameStorage storage $)
        internal
        view
        returns (uint64 flown, uint64 intercepted, uint64 missed, uint32 epoch)
    {
        epoch = _epochOf(uint64(block.number), $.params.epochBlocks, $.genesisBlock);
        flown = uint64(epoch);

        GameTypes.Attack storage current = $.attacks[_epochAttackId(epoch)];
        if (flown > 0 && current.id != bytes32(0) && block.number < current.impactBlock) {
            flown -= 1;
        }

        intercepted = $.interceptedAttacks;
        // Clamped rather than trusted: interceptions are counted as they
        // happen and the tally is derived from the clock, so a governed
        // change to `epochBlocks` could momentarily leave the second behind
        // the first. An underflow here would revert every read on the page.
        missed = flown > intercepted ? flown - intercepted : 0;
    }
}
