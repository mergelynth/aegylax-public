// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {AegylaxStorage} from "../AegylaxStorage.sol";
import {IAegylaxEvents} from "../interfaces/IAegylaxEvents.sol";
import {Epochs} from "./Epochs.sol";
import {GameTypes} from "./GameTypes.sol";
import {Geometry} from "./Geometry.sol";
import {Settlement} from "./Settlement.sol";

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
    /// Folding a miss into an open draw would overflow `uint128` bounty fields.
    error DrawBountyOverflow();
    error UnknownLobby();
    error WrongLobbyStatus();
    error RegistrationClosed();
    error NotParticipant();
    error TransferFailed();
    error RegistrationStillOpen();
    error MinPlayersNotReached();

    /**
     * An operation, written into storage and bound to its epoch's threat.
     *
     * Shared by the two things that can create one — a player calling
     * `createLobby`, and the protocol opening its own draw — because the only
     * differences between them are who the creator is and whether a creation
     * fee was charged. A second copy of this for the protocol's own operation
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
        // The creator's protocol fee. Credited to the treasury at mint, and
        // booked here so a client can see what the protocol kept. It is
        // never released, even if the operation never runs.
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
         * epochs. The join window is a calendar day (at Base's 2s blocks);
         * if the whole interval is shorter than a day, half of it. Misses
         * *after* mint still grow this same bounty until the threat launches
         * (`topUpDraw`); only then does the idle pool start the next pile.
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

        /*
         * The wei stay in `globalDefensePool` until the round actually
         * starts. Mint used to drain the pile into this lobby, so a room
         * that never filled left the trophy at 0 until somebody sent
         * `cancelLobby`. An under-filled draw is now just a room: the
         * jackpot never left. `activate` is what escrows the pile — the
         * same moment fees stop being refundable on a player operation.
         */
        lobbyId = mintLobby(
            $,
            p,
            GameTypes.LobbyConfig({
                name: "Global Defense",
                minPlayers: p.minPlayers,
                maxPlayers: p.maxPlayers,
                entryPrice: 0,
                registrationDeadline: registrationDeadline,
                registrationDeadlineBlock: deadlineBlock,
                startPrizePool: 0,
                creatorFeeBps: 0
            }),
            address(this),
            0
        );

        $.globalDefenseLobby[epochId] = lobbyId;
        emit IAegylaxEvents.GlobalDefenseOpened(epochId, lobbyId, pool);
    }

    /**
     * Opens the draw when it is due, and folds later misses into it while it
     * has not launched.
     *
     * The protocol has no keeper and no backend. A dedicated `openGlobalDefense`
     * write still exists, but a game that only moves when somebody remembers
     * to click a trophy in the header is not autonomous. Any ordinary write
     * that already happens — creating, joining, scoring — is enough to mint
     * the lobby once the join window has started, enough to grow its bounty
     * when a later miss would otherwise wait for the next interval, and
     * enough to unwind an under-filled previous draw so the bounty is not
     * stranded in a room nobody is looking at (`unfilledPastDraw`).
     */
    function maybeOpenDraw(AegylaxStorage.GameStorage storage $) public {
        maybeCloseDraw($);
        topUpDraw($);
        if (!_drawDue($)) return;
        openDraw($);
    }

    /**
     * A protocol-owned draw whose join window has closed without a full room.
     *
     * The jackpot never left `globalDefensePool` on mint, so an under-filled
     * leftover cannot hide it. Closing still refunds anyone who sat down and
     * clears the room — the same permissionless path as opening, not a keeper.
     *
     * Zero if there is nothing to close: cadence off, no past draw, still
     * in the window, already past OPEN, or the room filled.
     */
    function unfilledPastDraw(AegylaxStorage.GameStorage storage $) public view returns (bytes32 lobbyId) {
        uint32 interval = $.globalDefenseEpochInterval;
        if (interval == 0) return bytes32(0);

        GameTypes.GameParams memory p = $.params;
        uint32 current = Epochs.epochOf(uint64(block.number), p.epochBlocks, $.genesisBlock);
        uint32 epochId = (current / interval) * interval;
        if (epochId == 0) return bytes32(0);

        lobbyId = $.globalDefenseLobby[epochId];
        if (lobbyId == bytes32(0)) return bytes32(0);

        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        if (lobby.status != GameTypes.LobbyStatus.OPEN) return bytes32(0);

        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        if (block.number < config.registrationDeadlineBlock) return bytes32(0);
        if (lobby.participantCount >= config.minPlayers) return bytes32(0);
    }

    function maybeCloseDraw(AegylaxStorage.GameStorage storage $) public {
        bytes32 drawId = unfilledPastDraw($);
        if (drawId == bytes32(0)) return;
        closeUnfilled($, drawId);
    }

    /**
     * ТЗ §18 — UNPLAYED rather than CANCELLED. Nothing went wrong with the
     * protocol: the room simply never filled, so no round was ever started
     * and everybody takes their money back.
     */
    function closeUnfilled(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        lobby.status = GameTypes.LobbyStatus.CANCELLED;
        lobby.ending = GameTypes.Ending.UNPLAYED;
        if ($.activeLobbies > 0) $.activeLobbies -= 1;
        Settlement.payoutUnplayed($, lobbyId);
        emit IAegylaxEvents.LobbyCancelled(lobbyId, "minimum defenders not reached");
    }

    /**
     * OPEN -> ACTIVE, once, whenever somebody first needs it to have
     * happened. Lives here so the implementation stays under EIP-170:
     * `commitDrawBounty` is the jackpot move, and inlining it in the game
     * pushed the runtime 41 bytes past 24,576.
     *
     * Idempotent by status: an operation already past OPEN returns
     * untouched, which is what makes it safe to call from everywhere.
     */
    function activate(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        if (lobby.status != GameTypes.LobbyStatus.OPEN) return;

        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        if (block.number < config.registrationDeadlineBlock) revert RegistrationStillOpen();
        if (lobby.participantCount < config.minPlayers) revert MinPlayersNotReached();

        // Protocol draw: the jackpot sat in the idle pool until this
        // moment. A room that never reached here never took it.
        commitDrawBounty($, lobbyId);

        lobby.rewardPool += lobby.entryFeesCollected;

        lobby.status = GameTypes.LobbyStatus.ACTIVE;
        lobby.startedAtBlock = uint64(block.number);

        emit IAegylaxEvents.OperationStarted(lobbyId, lobby.epochId, uint64(block.number));
    }

    /**
     * Escrow the idle jackpot into a protocol draw that is actually starting.
     *
     * Called from `activate`, not from mint: until enough defenders sit
     * down the pile is still `globalDefensePool`, so an under-filled room
     * cannot hide it. Once this runs the bounty is frozen in the lobby the
     * same way a player operation's start prize is.
     */
    function commitDrawBounty(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        if (lobby.creator != address(this)) return;

        uint256 pooled = $.globalDefensePool;
        if (pooled == 0) return;

        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        uint256 nextReward = uint256(lobby.rewardPool) + pooled;
        uint256 nextStart = uint256(config.startPrizePool) + pooled;
        if (nextReward > type(uint128).max || nextStart > type(uint128).max) revert DrawBountyOverflow();

        $.globalDefensePool = 0;
        lobby.rewardPool = uint128(nextReward);
        config.startPrizePool = uint128(nextStart);
        emit IAegylaxEvents.DefensePoolFunded(lobbyId, pooled, 0);
    }

    /**
     * If the next draw is already minted and the threat has not launched,
     * move the idle pool into that lobby's bounty.
     *
     * Only for a draw that has already taken the pile (`commitDrawBounty`).
     * An OPEN protocol room still leaves later misses in `globalDefensePool`
     * — that is the pile the trophy reads, and moving it early is how an
     * under-filled room used to read 0.
     */
    function topUpDraw(AegylaxStorage.GameStorage storage $) public {
        uint256 extra = $.globalDefensePool;
        if (extra == 0) return;

        bytes32 drawId = _unlaunchedDraw($);
        if (drawId == bytes32(0)) return;
        if ($.lobbies[drawId].creator == address(this) && $.lobbies[drawId].status == GameTypes.LobbyStatus.OPEN) {
            return;
        }

        $.globalDefensePool = 0;
        _addToDrawBounty($, drawId, extra);
        emit IAegylaxEvents.DefensePoolFunded(drawId, extra, 0);
    }

    function _unlaunchedDraw(AegylaxStorage.GameStorage storage $) private view returns (bytes32 drawId) {
        uint32 interval = $.globalDefenseEpochInterval;
        if (interval == 0) return bytes32(0);

        GameTypes.GameParams memory p = $.params;
        uint32 current = Epochs.epochOf(uint64(block.number), p.epochBlocks, $.genesisBlock);
        uint32 epochId = (current / interval + 1) * interval;
        drawId = $.globalDefenseLobby[epochId];
        if (drawId == bytes32(0)) return bytes32(0);
        // Freeze once the threat is in flight (ACTIVE) or the room has ended.
        if ($.lobbies[drawId].status >= GameTypes.LobbyStatus.ACTIVE) return bytes32(0);
    }

    function _addToDrawBounty(AegylaxStorage.GameStorage storage $, bytes32 drawId, uint256 amount) private {
        GameTypes.Lobby storage draw = $.lobbies[drawId];
        uint256 nextReward = uint256(draw.rewardPool) + amount;
        uint256 nextStart = uint256($.lobbyConfigs[drawId].startPrizePool) + amount;
        if (nextReward > type(uint128).max || nextStart > type(uint128).max) revert DrawBountyOverflow();
        draw.rewardPool = uint128(nextReward);
        // `startPrizePool` is what UNPLAYED `creatorDue` returns to the pool,
        // and what the header reads as the advertised bounty. Both have to
        // move with `rewardPool` or a cancel would strand the top-up.
        $.lobbyConfigs[drawId].startPrizePool = uint128(nextStart);
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

    /**
     * Leave before the operation starts (ТЗ §2).
     *
     * Legal only while applications are open. What comes out is exactly what
     * went in — entry, the author's commission and any probes bought.
     */
    function leave(AegylaxStorage.GameStorage storage $, bytes32 lobbyId) public {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        if (lobby.status == GameTypes.LobbyStatus.NONE) revert UnknownLobby();
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];

        if (lobby.status != GameTypes.LobbyStatus.OPEN) revert WrongLobbyStatus();
        if (block.number >= config.registrationDeadlineBlock) revert RegistrationClosed();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();

        uint256 refund = participant.paidIn;
        uint128 probeRefund = participant.probesPaid;
        uint256 consumed = uint256(probeRefund) + uint256(config.entryPrice);
        uint256 commissionPaid = uint256(refund) > consumed ? uint256(refund) - consumed : 0;

        participant.joined = false;
        participant.paidIn = 0;
        participant.probesPurchased = 0;
        participant.probesPaid = 0;

        lobby.participantCount -= 1;
        lobby.entryFeesCollected -= config.entryPrice;
        lobby.creatorFeeAccrued -= uint128(commissionPaid);
        if (probeRefund > 0) {
            lobby.probeFeesCollected -= probeRefund;
            lobby.rewardPool -= probeRefund;
        }
        _removeParticipant($.lobbyParticipants[lobbyId], msg.sender);

        _pay(payable(msg.sender), refund);
        emit IAegylaxEvents.PlayerLeft(lobbyId, msg.sender, refund, lobby.participantCount);
    }

    function _removeParticipant(address[] storage list, address who) private {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == who) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    function _pay(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
