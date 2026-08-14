// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxStorage} from "../AegylaxStorage.sol";
import {IAegylaxEvents} from "../interfaces/IAegylaxEvents.sol";
import {Epochs} from "./Epochs.sol";
import {GameTypes} from "./GameTypes.sol";
import {Geometry} from "./Geometry.sol";

/**
 * Where an operation comes into existence, and where the protocol's own
 * Global Defense draw is opened.
 *
 * An external library, for the same reason `ProtocolRules`, `Resolution` and
 * `Settlement` are: `AegylaxGame` does not fit in one deployed code object.
 * That is not a hypothetical constraint here — adding the three-endings model
 * and the draw put the implementation 2,049 bytes past EIP-170's 24,576, and
 * this is the extraction that brought it back under. It runs by `delegatecall`
 * in the proxy's storage context, so `$` is the same storage the game writes,
 * `address(this)` is still the proxy, and the events below are logged against
 * the proxy's address exactly as if the game had emitted them.
 *
 * The creation path is a good boundary to have been forced into. Everything
 * here answers one question — *what is true the moment an operation exists* —
 * and the answer is more than it looks: the operation is written, the epoch's
 * threat is scheduled, and if this is the first operation into that epoch, the
 * threat's secret is drawn. Nothing after creation ever revisits any of it.
 */
library Lobbies {
    /// `openDraw` on an epoch the draw interval does not land on.
    error NotADrawEpoch();
    error DrawAlreadyOpen();
    error DrawNotFunded();
    error DrawEpochPassed();
    /// `openDraw` before the join window — too early, the interval is still accumulating.
    error DrawNotDue();

    /**
     * An operation, written into storage and bound to its epoch's threat.
     *
     * Shared by the two things that can create one — a player calling
     * `createLobby`, and the protocol opening its own draw — because the only
     * differences between them are who the creator is and whether a seat fee
     * was charged. A second copy of this for the protocol's own operation
     * would be a second place for the scheduling rule to drift.
     */
    function mintLobby(
        AegylaxStorage.GameStorage storage $,
        GameTypes.GameParams memory p,
        GameTypes.LobbyConfig memory config,
        address creator,
        uint128 seatFee
    ) public returns (bytes32 lobbyId) {
        unchecked {
            $.lobbyNonce += 1;
        }
        lobbyId = keccak256(abi.encode(block.chainid, address(this), creator, $.lobbyNonce, block.number));

        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        lobby.id = lobbyId;
        lobby.creator = creator;
        lobby.createdAtBlock = uint64(block.number);
        lobby.createdAtTimestamp = uint64(block.timestamp);
        lobby.status = GameTypes.LobbyStatus.OPEN;
        lobby.paramsVersion = $.paramsVersion;
        lobby.rewardPool = config.startPrizePool;
        // The creator's own join fee. Deliberately *not* part of `rewardPool`:
        // it is the protocol's money, not the operation's, and folding it into
        // the pool would pay it out to whoever intercepted.
        lobby.protocolFeeAccrued = seatFee;

        /*
         * The threat is scheduled here, at creation, and never again.
         *
         * Applications close on a *block*, so the epoch that block falls in is
         * arithmetic the contract can do immediately — and the attack belongs
         * to a later epoch. What that buys is who has to be present for it to
         * happen: nobody. There is no transition anybody must send, no keeper
         * to be online and no "first player to act decides which epoch we
         * play"; the operation knows its attack from the moment it exists,
         * and every client counts down to the same block without asking
         * permission.
         *
         * The naive schedule is the epoch after the deadline's. That is
         * still the answer when that boundary is far enough away that the
         * join window and the launch are different events. It is not the
         * answer when the deadline sits in the last 10% of an epoch: then
         * `epochOf + 1` would fire the attack one block after applications
         * close. `launchEpochOf` skips that boundary. The protocol's own
         * Global Defense draw is the exception — it *intends* to close on
         * the last block of the previous epoch and fly on the next, and
         * `address(this)` as creator is how this function tells the two
         * apart without a second mint path.
         *
         * The epoch's secret is minted on the spot too (`ensureEpochAttack` is
         * idempotent — the first operation into an epoch pays for the draw and
         * every later one binds to what is already there).
         */
        uint32 launchEpoch = creator == address(this)
            ? Epochs.epochOf(config.registrationDeadlineBlock, p.epochBlocks, $.genesisBlock) + 1
            : Epochs.launchEpochOf(config.registrationDeadlineBlock, p.epochBlocks, $.genesisBlock);
        lobby.epochId = launchEpoch;
        lobby.attackId = ensureEpochAttack($, launchEpoch);

        $.lobbyConfigs[lobbyId] = config;
        $.lobbyParams[lobbyId] = p;
        $.lobbyIds.push(lobbyId);
        unchecked {
            $.totalLobbies += 1;
            $.activeLobbies += 1;
        }

        emit IAegylaxEvents.LobbyCreated(
            lobbyId,
            creator,
            config.entryPrice,
            config.startPrizePool,
            config.registrationDeadline,
            lobby.paramsVersion,
            config.name
        );

        GameTypes.Attack storage scheduled = $.attacks[lobby.attackId];
        emit IAegylaxEvents.AttackStarted(
            lobbyId, lobby.attackId, scheduled.launchBlock, scheduled.impactBlock, scheduled.flightBlocks
        );
    }

    /**
     * The epoch's attack, minted on first demand.
     *
     * One threat per epoch, shared by every operation that starts into it — so
     * the first team to close its applications pays for drawing it and
     * everyone after binds to what is already there. The identity is the epoch
     * itself, which is what lets any caller name the attack without consulting
     * storage, and what makes "the epoch's attack" a fact rather than a lookup.
     *
     * The rules it will be generated and resolved under are snapshotted here,
     * at the one moment the attack becomes real.
     */
    function ensureEpochAttack(AegylaxStorage.GameStorage storage $, uint32 launchEpoch)
        public
        returns (bytes32 attackId)
    {
        attackId = Epochs.attackId(launchEpoch);

        GameTypes.Attack storage attack = $.attacks[attackId];
        if (attack.id != bytes32(0)) return attackId;

        GameTypes.GameParams memory p = $.params;
        $.epochParams[launchEpoch] = p;

        uint64 launchBlock = Epochs.epochStart(launchEpoch, p.epochBlocks, $.genesisBlock);

        attack.id = attackId;
        attack.epochId = launchEpoch;
        attack.launchBlock = launchBlock;
        attack.impactBlock = launchBlock + p.epochBlocks;
        attack.flightBlocks = p.epochBlocks;
        attack.status = GameTypes.AttackStatus.PENDING;

        /*
         * The geometry is drawn now and read by nobody until it lands.
         *
         * The engine sees `msg.sender` as the proxy, not as this library —
         * a `delegatecall` keeps the caller's identity as well as its storage
         * — which is what lets the engine's `onlyGame` check keep working
         * unchanged with this code living outside the game.
         */
        (bytes32 bearingHandle, bytes32 deltaHandle) = $.engine.newAttackSecret(
            attackId,
            uint32(uint256(Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD)),
            uint32(uint256(Geometry.MAX_IMPACT_DELTA_MICRO_RAD))
        );
        attack.bearingHandle = bearingHandle;
        attack.deltaHandle = deltaHandle;

        unchecked {
            $.totalAttacks += 1;
        }
    }

    /**
     * Opens the protocol's own operation for an epoch's Global Defense draw
     * (ТЗ §18).
     *
     * The Global Defense Pool is every unwon pool the protocol has collected:
     * each COMPLETED round the threat got through sends its money there rather
     * than home to its creator. This is where it goes back into play. Once
     * every `globalDefenseEpochInterval` epochs the protocol opens an operation
     * of its own — free to enter, no creator fee, the whole accumulated pool as
     * the bounty — and whoever intercepts that epoch's threat takes all of it.
     *
     * **If nobody wins it, nothing special happens, and that is the design.** A
     * draw that ends with no interception is an ordinary COMPLETED round with
     * no winner, so `resolveLobby` returns its pool to the Global Defense Pool
     * by exactly the same rule that filled it in the first place, and it waits
     * for the next interval. A draw nobody joins ends UNPLAYED, and
     * `settleCreator` returns the bounty to the pool because this contract is
     * its creator. There is no "the draw failed" branch anywhere, because every
     * way it can fail is already a rule the protocol has.
     *
     * Permissionless, like every other transition the clock owns: the protocol
     * has no keeper, so opening the draw has to be something anybody can do
     * once the chain says it is due.
     */
    function openDraw(AegylaxStorage.GameStorage storage $) public returns (bytes32 lobbyId, uint32 epochId) {
        GameTypes.GameParams memory p = $.params;

        uint32 interval = $.globalDefenseEpochInterval;
        if (interval == 0) revert NotADrawEpoch();

        /*
         * The next draw epoch strictly after the current one. Derived rather
         * than taken as an argument: there is exactly one epoch this call can
         * legally open at any moment, so letting a caller name it only creates
         * ways to name the wrong one.
         */
        uint32 current = Epochs.epochOf(uint64(block.number), p.epochBlocks, $.genesisBlock);
        epochId = (current / interval + 1) * interval;
        if ($.globalDefenseLobby[epochId] != bytes32(0)) revert DrawAlreadyOpen();

        uint256 pool = $.globalDefensePool;
        if (pool == 0) revert DrawNotFunded();

        /*
         * Applications close on the last block of the previous epoch, because
         * `mintLobby` schedules the threat for the epoch *after* the one the
         * deadline falls in. That has to be in the future — an operation
         * cannot be opened for a draw already under way.
         *
         * They do not *open* that far out. A draw opened at epoch 457 for
         * epoch 1000 would sit with the jackpot inside it for hundreds of
         * epochs, the header reading 0, and nothing accumulating toward the
         * next one. The join window is a calendar day (at Base's 2s blocks);
         * if the whole interval is shorter than a day, half of it — so there
         * is always time to walk in *and* time afterwards to pile prizes
         * toward the next interval.
         */
        uint64 deadlineBlock = Epochs.epochStart(epochId, p.epochBlocks, $.genesisBlock) - 1;
        if (block.number >= deadlineBlock) revert DrawEpochPassed();

        uint256 intervalBlocks = uint256(interval) * uint256(p.epochBlocks);
        uint256 dayBlocks = 1 days / 2;
        uint256 joinBlocks = intervalBlocks < dayBlocks
            ? (intervalBlocks / 2 == 0 ? 1 : intervalBlocks / 2)
            : dayBlocks;
        uint64 openFrom = deadlineBlock > joinBlocks ? deadlineBlock - uint64(joinBlocks) : uint64(0);
        if (block.number < openFrom) revert DrawNotDue();

        uint256 remaining = uint256(deadlineBlock) - block.number;
        uint64 registrationDeadline = uint64(block.timestamp + remaining * 2);

        $.globalDefensePool = 0;

        lobbyId = mintLobby(
            $,
            p,
            GameTypes.LobbyConfig({
                name: "Global Defense",
                minPlayers: p.minPlayers,
                // The protocol ceiling, not a smaller jackpot-only cap. A
                // draw opened under an older params version keeps that
                // version's number — the lobby snapshot does not follow
                // later `setParams`.
                maxPlayers: p.maxPlayers,
                // Free to enter. The pool is already the players' own money,
                // forfeited from rounds they lost; charging them to play for it
                // back would be selling them their own stake a second time.
                entryPrice: 0,
                registrationDeadline: registrationDeadline,
                registrationDeadlineBlock: deadlineBlock,
                startPrizePool: uint128(pool),
                // Nobody owns this operation, so nobody takes a cut of it.
                creatorFeeBps: 0
            }),
            address(this),
            // The protocol charging itself a fee it also collects would be
            // moving money between its own pockets and calling it revenue.
            0
        );

        $.globalDefenseLobby[epochId] = lobbyId;
        emit IAegylaxEvents.GlobalDefenseOpened(epochId, lobbyId, pool);
    }

    /**
     * Opens the draw when it is due, and does nothing otherwise.
     *
     * The protocol has no keeper and no backend. A dedicated `openGlobalDefense`
     * write still exists, but a game that only moves when somebody remembers
     * to click a trophy in the header is not autonomous. Any ordinary write
     * that already happens — creating, joining, scoring — is enough to mint
     * the lobby once the join window has started.
     */
    function maybeOpenDraw(AegylaxStorage.GameStorage storage $) public {
        if (!_drawDue($)) return;
        openDraw($);
    }

    function _drawDue(AegylaxStorage.GameStorage storage $) private view returns (bool) {
        uint32 interval = $.globalDefenseEpochInterval;
        if (interval == 0) return false;
        if ($.globalDefensePool == 0) return false;

        GameTypes.GameParams memory p = $.params;
        uint32 current = Epochs.epochOf(uint64(block.number), p.epochBlocks, $.genesisBlock);
        uint32 epochId = (current / interval + 1) * interval;
        if ($.globalDefenseLobby[epochId] != bytes32(0)) return false;

        uint64 deadlineBlock = Epochs.epochStart(epochId, p.epochBlocks, $.genesisBlock) - 1;
        if (block.number >= deadlineBlock) return false;

        uint256 intervalBlocks = uint256(interval) * uint256(p.epochBlocks);
        uint256 dayBlocks = 1 days / 2;
        uint256 joinBlocks = intervalBlocks < dayBlocks
            ? (intervalBlocks / 2 == 0 ? 1 : intervalBlocks / 2)
            : dayBlocks;
        uint64 openFrom = deadlineBlock > joinBlocks ? deadlineBlock - uint64(joinBlocks) : uint64(0);
        return block.number >= openFrom;
    }
}
