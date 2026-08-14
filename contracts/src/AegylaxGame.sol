// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IAegylaxEvents} from "./interfaces/IAegylaxEvents.sol";
import {IConfidentialEngine} from "./interfaces/IConfidentialEngine.sol";
import {AegylaxStorage} from "./AegylaxStorage.sol";
import {GameTypes} from "./libraries/GameTypes.sol";
import {ProtocolRules} from "./libraries/ProtocolRules.sol";
import {Resolution} from "./libraries/Resolution.sol";
import {Settlement} from "./libraries/Settlement.sol";
import {Geometry} from "./libraries/Geometry.sol";
import {Lobbies} from "./libraries/Lobbies.sol";
import {ReconRules} from "./libraries/ReconRules.sol";

/**
 * AEGYLAX — the protocol.
 *
 * The chain is the source of truth for an operation's entire life: who
 * joined, what they paid, when the attack launches, who probed, who
 * defended, where the threat actually went, who intercepted it first, and
 * who is owed what. Nothing in that list is computed by a frontend and
 * reported here; every one of them is decided in this contract, and the
 * frontend reads the answer.
 *
 * The single thing this contract deliberately cannot do is *see* an attack
 * before it lands. The geometry is drawn inside the confidential engine and
 * stays there as two opaque handles until the flight is over, so there is
 * no privileged reader — no owner, no upgrader, no block producer, no
 * covalidator operator acting alone — who can learn where a threat is going
 * while there is still time to defend against it. The reveal is what turns
 * those handles back into coordinates, and it is permissionless: anybody
 * can carry an attested decryption back on chain, which is what stops a
 * finished operation from depending on the goodwill of whoever lost it.
 *
 * Upgradeability is UUPS with ERC-7201 namespaced storage. Both halves of
 * that matter: namespaced storage means an upgrade adds fields without a
 * gap-counting ritual, and every running operation carries a *snapshot* of
 * the parameters it was created under, so neither a parameter change nor a
 * new implementation can move the goalposts under a game in progress.
 */
contract AegylaxGame is
    AegylaxStorage,
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IAegylaxEvents
{
    using GameTypes for GameTypes.Lobby;

    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------

    error UnknownLobby();
    error UnknownAttack();
    error WrongLobbyStatus();
    error WrongAttackStatus();
    error NotCreator();
    error NotParticipant();
    error AlreadyJoined();
    error LobbyFull();
    error RegistrationClosed();
    error RegistrationStillOpen();
    error IncorrectPayment();
    error NoProbesLeft();
    error ProbeLimitReached();
    error SensorOffBoard();
    error ProbeInFlight();
    error ProbeNotReadable();
    error UnknownProbe();
    error ProbeAlreadyGranted();
    error DefenseAlreadySubmitted();
    error DefenseWindowClosed();
    error AttackNotLanded();
    error AlreadyRevealed();
    error RevealNotUnlocked();
    error InvalidDecryptionProof(uint256 index);
    error ProofCountMismatch();
    error NothingToClaim();
    error AlreadyClaimed();
    error TransferFailed();
    error EngineNotSet();
    error MinPlayersNotReached();
    error UnknownSelector();

    event LensUpdated(address indexed lens);

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------

    /// The layout itself is declared once, in `AegylaxStorage`, and shared with the lens.
    function _s() private pure returns (GameStorage storage $) {
        return _gameStorage();
    }

    // -----------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address engine_, GameTypes.GameParams calldata params_, uint64 genesisBlock_)
        external
        initializer
    {
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        GameStorage storage $ = _s();
        ProtocolRules.validateParams(params_);
        $.params = params_;
        $.paramsVersion = 1;
        $.genesisBlock = genesisBlock_ == 0 ? uint64(block.number) : genesisBlock_;
        _setEngine(engine_);
        emit ParamsUpdated(1);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// Implementation version — bumped by hand with every deployed implementation.
    function version() external pure virtual returns (string memory) {
        return "1.3.1";
    }

    // -----------------------------------------------------------------
    // Governance
    // -----------------------------------------------------------------

    /**
     * Replaces the protocol's rules for *future* operations.
     *
     * Running operations are untouched: each one holds its own copy of the
     * parameters it was created under, so a governance action can never
     * change the interception radius, the flight duration or the fee
     * ceilings of a game somebody is already playing (ТЗ §8).
     */
    function setParams(GameTypes.GameParams calldata params_) external onlyOwner {
        GameStorage storage $ = _s();
        ProtocolRules.validateParams(params_);
        $.params = params_;
        unchecked {
            $.paramsVersion += 1;
        }
        emit ParamsUpdated($.paramsVersion);
    }

    /**
     * Turns the Global Defense draw on, off, or on to a different cadence
     * (ТЗ §18).
     *
     * Its own call rather than a field of `setParams`, for the same two
     * reasons it is its own storage field: the cadence is a protocol schedule
     * and not a rule any operation is played under, and `GameParams` is packed
     * inline in the layout with no room to grow. Zero disables the draw and
     * leaves the pool accumulating, which is what an upgraded deployment reads
     * until the owner decides otherwise.
     */
    function setGlobalDefenseInterval(uint32 epochs) external onlyOwner {
        _s().globalDefenseEpochInterval = epochs;
        emit GlobalDefenseIntervalUpdated(epochs);
    }

    /**
     * Points the protocol at a different confidential engine.
     *
     * Only new attacks are affected — an attack in flight keeps the handles
     * it was generated with, and its reveal keeps going through the engine
     * that drew them. That is what makes an engine upgrade (a new Inco
     * release, say) safe to perform mid-round.
     */
    function setEngine(address engine_) external onlyOwner {
        _setEngine(engine_);
    }

    function setPaused(bool paused_) external onlyOwner {
        if (paused_) _pause();
        else _unpause();
    }

    function withdrawProtocolFees(address payable to, uint256 amount) external onlyOwner nonReentrant {
        GameStorage storage $ = _s();
        if (amount > $.protocolTreasury) revert NothingToClaim();
        $.protocolTreasury -= amount;
        _pay(to, amount);
        emit ProtocolFeesWithdrawn(to, amount);
    }

    /// Tops the confidential engine up out of protocol fees — it pays Inco per operation.
    function fundEngine(uint256 amount) external onlyOwner nonReentrant {
        GameStorage storage $ = _s();
        if (amount > $.protocolTreasury) revert NothingToClaim();
        $.protocolTreasury -= amount;
        _pay(payable(address($.engine)), amount);
    }

    function _setEngine(address engine_) private {
        if (engine_ == address(0)) revert EngineNotSet();
        GameStorage storage $ = _s();
        $.engine = IConfidentialEngine(engine_);
        emit ConfidentialEngineUpdated(engine_, IConfidentialEngine(engine_).engineKind());
    }

    // -----------------------------------------------------------------
    // Lobby lifecycle
    // -----------------------------------------------------------------

    function createLobby(GameTypes.LobbyConfig calldata config)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 lobbyId)
    {
        GameStorage storage $ = _s();
        Lobbies.maybeOpenDraw($);
        GameTypes.GameParams memory p = $.params;
        ProtocolRules.validateConfig(config, p, block.timestamp, block.number);

        /*
         * ТЗ §17 — the protocol's fee is charged **once per seat, and the
         * creator holds a seat.**
         *
         * Creating an operation used to be the one way to occupy the protocol
         * without paying it: every joiner paid `entryPrice + protocolJoinFee`
         * while the creator paid only their own bounty, so the address that
         * mints an epoch's attack, takes a Creator Fee off every entry and
         * gets its bounty back on a miss was also the address the treasury
         * never saw a wei from. Charging it here closes that, and it is the
         * honest reading of a *join* fee: the creator is the first party to
         * the operation, not an outside sponsor of it.
         *
         * It rides on the lobby's own `protocolFeeAccrued`, which is what
         * makes it behave correctly at both endings without a second rule —
         * it moves to the treasury when the operation activates, and it is
         * inside the sum a cancelled or unplayed operation gives back.
         */
        if (msg.value != uint256(config.startPrizePool) + uint256(p.protocolJoinFee)) revert IncorrectPayment();

        lobbyId = Lobbies.mintLobby($, p, config, msg.sender, p.protocolJoinFee);
    }

    function joinLobby(bytes32 lobbyId) external payable whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        GameTypes.GameParams storage p = $.lobbyParams[lobbyId];

        if (lobby.status != GameTypes.LobbyStatus.OPEN) revert WrongLobbyStatus();
        // The block, not the timestamp: it is the deadline the attack was
        // scheduled from, so it is the one a seat has to be taken before.
        if (block.number >= config.registrationDeadlineBlock) revert RegistrationClosed();
        if (lobby.participantCount >= config.maxPlayers) revert LobbyFull();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (participant.joined) revert AlreadyJoined();

        /*
         * The protocol's own draw is free to sit in. Entry is already 0;
         * charging the join fee as well would be selling players a ticket
         * to play for money that was already theirs. A player-created
         * operation still takes the fee — that is protocol revenue.
         */
        uint256 seatFee = lobby.creator == address(this) ? 0 : uint256(p.protocolJoinFee);
        uint256 cost = uint256(config.entryPrice) + seatFee;
        if (msg.value != cost) revert IncorrectPayment();

        participant.joined = true;
        participant.joinedAtBlock = uint64(block.number);
        participant.paidIn = uint128(cost);

        $.lobbyParticipants[lobbyId].push(msg.sender);
        lobby.participantCount += 1;
        lobby.entryFeesCollected += config.entryPrice;
        lobby.protocolFeeAccrued += uint128(seatFee);

        emit PlayerJoined(lobbyId, msg.sender, cost, lobby.participantCount);
    }

    /**
     * Leave before the operation starts (ТЗ §2).
     *
     * Legal only while applications are open: once the attack is scheduled
     * the seat is committed, and a defender who could withdraw afterwards
     * would be able to watch the reconnaissance and take their money back.
     * What comes out is exactly what went in — entry, protocol fee and any
     * probes bought — because nothing has been consumed yet.
     */
    function leaveLobby(bytes32 lobbyId) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];

        if (lobby.status != GameTypes.LobbyStatus.OPEN) revert WrongLobbyStatus();
        /*
         * Applications closing is now a block passing rather than a
         * transaction landing, so the lobby can sit in OPEN after its
         * deadline until somebody's first in-round action activates it.
         * Without this check that gap would be a withdrawal window on an
         * operation that is already committed to its attack — the exact
         * thing the status check used to close by accident.
         */
        if (block.number >= config.registrationDeadlineBlock) revert RegistrationClosed();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();

        uint256 refund = participant.paidIn;
        uint128 probeRefund = participant.probesPaid;
        uint256 consumed = uint256(probeRefund) + uint256(config.entryPrice);
        uint256 seatFeePaid = uint256(refund) > consumed ? uint256(refund) - consumed : 0;

        participant.joined = false;
        participant.paidIn = 0;
        participant.probesPurchased = 0;
        participant.probesPaid = 0;

        lobby.participantCount -= 1;
        lobby.entryFeesCollected -= config.entryPrice;
        lobby.protocolFeeAccrued -= uint128(seatFeePaid);
        if (probeRefund > 0) {
            lobby.probeFeesCollected -= probeRefund;
            lobby.rewardPool -= probeRefund;
        }
        _removeParticipant($.lobbyParticipants[lobbyId], msg.sender);

        _pay(payable(msg.sender), refund);
        emit PlayerLeft(lobbyId, msg.sender, refund, lobby.participantCount);
    }

    /**
     * Buy Recon Probes (ТЗ §3).
     *
     * The window closes at the launch, not at the impact. Recon is
     * *equipment*, bought before the threat is in the sky; a probe purchased
     * mid-flight would be bought by somebody who has already watched the
     * launch, and — because a player may keep probing right up to their own
     * Send Defense — it would let a defender who did not prepare simply buy
     * their way to a fix once the clock was running. Preparing for an attack
     * and reacting to one are meant to be different things.
     *
     * So: while applications are open, or after they close but before the
     * attack leaves the ground. `startOperation` schedules the launch a full
     * epoch ahead, so that second window is a real one rather than a
     * technicality.
     */
    function buyProbes(bytes32 lobbyId, uint16 count) external payable whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);

        /*
         * One rule now, for both statuses: probes are equipment, and the
         * window shuts when the threat leaves the ground.
         *
         * This used to need two branches because an OPEN lobby had no attack
         * to measure against — it was scheduled by `startOperation`. Every
         * operation is bound to its attack at creation, so the launch block
         * is knowable the whole way through and the distinction disappears.
         */
        if (lobby.status != GameTypes.LobbyStatus.OPEN && lobby.status != GameTypes.LobbyStatus.ACTIVE) {
            revert WrongLobbyStatus();
        }
        if (block.number >= $.attacks[lobby.attackId].launchBlock) revert DefenseWindowClosed();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (count == 0) revert ProbeLimitReached();

        /*
         * Recon is priced by the protocol as it stands, not by the terms
         * this operation froze at creation. The threat is the epoch's, so
         * two teams facing the same attack have to buy knowledge of it at
         * the same price — a frozen copy would let an operation created
         * under an older, cheaper regime resell the epoch's intelligence.
         */
        GameTypes.GameParams storage live = $.params;

        uint16 owned = live.freeProbes + participant.probesPurchased;
        if (uint256(owned) + uint256(count) > live.maxProbesPerPlayer) revert ProbeLimitReached();

        uint256 cost = uint256(live.probePrice) * uint256(count);
        if (msg.value != cost) revert IncorrectPayment();

        participant.probesPurchased += count;
        participant.probesPaid += uint128(cost);
        participant.paidIn += uint128(cost);
        lobby.probeFeesCollected += uint128(cost);
        // Probe purchases raise the bounty rather than the protocol's take:
        // money a defender spends on intelligence stays in the operation.
        lobby.rewardPool += uint128(cost);

        emit ProbesPurchased(lobbyId, msg.sender, count, cost);
    }

    /**
     * Closes applications, for anybody who wants to see it happen.
     *
     * Nothing depends on this any more. The attack was scheduled when the
     * operation was created and flies on its own; all that is left here is
     * the money — the Creator Fee and the protocol fee stop being
     * refundable, and the entry residual becomes the reward pool — and that
     * is settled by whichever transaction needs it first (`_activate`). The
     * function stays because the transition is worth being able to trigger
     * deliberately, and because an operation whose players never act still
     * has to be able to reach ACTIVE before it can be scored.
     */
    function startOperation(bytes32 lobbyId) external whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        _lobby($, lobbyId);
        _activate($, lobbyId);
    }

    /**
     * OPEN -> ACTIVE, once, whenever somebody first needs it to have
     * happened.
     *
     * This is the whole of what used to be `startOperation`, minus the
     * scheduling: applications are over, enough defenders came, and the
     * money moves out of refundable into committed. Every in-round entry
     * point calls it, so the first probe or defense of the round pays for
     * the transition as a side effect of an action the player was taking
     * anyway — and an operation nobody touches is settled by the reveal.
     *
     * Idempotent by status: an operation already past OPEN returns
     * untouched, which is what makes it safe to call from everywhere.
     */
    function _activate(GameStorage storage $, bytes32 lobbyId) private {
        GameTypes.Lobby storage lobby = $.lobbies[lobbyId];
        if (lobby.status != GameTypes.LobbyStatus.OPEN) return;

        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];
        if (block.number < config.registrationDeadlineBlock) revert RegistrationStillOpen();
        if (lobby.participantCount < config.minPlayers) revert MinPlayersNotReached();

        // Fees stop being refundable here, and only here.
        uint256 creatorFee = (uint256(lobby.entryFeesCollected) * uint256(config.creatorFeeBps)) / GameTypes.BPS;
        uint256 residual = uint256(lobby.entryFeesCollected) - creatorFee;

        lobby.creatorFeeAccrued = uint128(creatorFee);
        // Entry fees left after the Creator Fee stay inside the operation,
        // as the reward pool — the only destination that neither orphans
        // them on chain nor quietly hands the creator a second fee.
        lobby.rewardPool += uint128(residual);
        $.protocolTreasury += lobby.protocolFeeAccrued;

        lobby.status = GameTypes.LobbyStatus.ACTIVE;
        lobby.startedAtBlock = uint64(block.number);

        emit OperationStarted(lobbyId, lobby.epochId, uint64(block.number));
    }

    /**
     * Opens the protocol's own operation for the next Global Defense draw
     * (ТЗ §18). Permissionless — the protocol has no keeper, so this is
     * something anybody may do once the chain says it is due.
     *
     * The whole of it lives in `Lobbies`, with the creation path it shares;
     * see that library for why the draw needs no failure branch of its own.
     */
    function openGlobalDefense() external whenNotPaused nonReentrant returns (bytes32 lobbyId, uint32 epochId) {
        return Lobbies.openDraw(_s());
    }

    /// Applications closed without enough defenders: everybody gets their money back.
    function cancelLobby(bytes32 lobbyId) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];

        if (lobby.status != GameTypes.LobbyStatus.OPEN) revert WrongLobbyStatus();
        // The block, for the same reason joining uses it: this is the
        // deadline the operation was actually built around.
        if (block.number < config.registrationDeadlineBlock) revert RegistrationStillOpen();
        if (lobby.participantCount >= config.minPlayers) revert MinPlayersNotReached();

        lobby.status = GameTypes.LobbyStatus.CANCELLED;
        /*
         * ТЗ §18 — UNPLAYED rather than CANCELLED. Nothing went wrong with the
         * protocol: the room simply never filled, so no round was ever
         * started and everybody takes their money back. Calling this a
         * cancellation would put it in the same bucket as an operation the
         * protocol failed to run, which is a claim about us rather than about
         * the turnout.
         */
        lobby.ending = GameTypes.Ending.UNPLAYED;
        if ($.activeLobbies > 0) $.activeLobbies -= 1;
        emit LobbyCancelled(lobbyId, "minimum defenders not reached");
    }

    // -----------------------------------------------------------------
    // In-round actions
    // -----------------------------------------------------------------

    /**
     * Send Recon Probe (ТЗ §3, §4).
     *
     * The probe's answer is computed inside the confidential engine against
     * the sealed bearing and handed to this caller alone. What lands on
     * chain is that a probe was sent and an opaque handle; what the probe
     * actually said never exists in plaintext anywhere the protocol or
     * another player can reach.
     *
     * A probe does not choose a sector to look at — it scans everything, and
     * what changes is *where it stands*. The sensor's cell is the whole of
     * the input, and it is snapped to the playfield grid on purpose: a
     * continuous position would let a player step one micrometre sideways to
     * shake out a fresh reading, which is the Sybil hole in another costume.
     * A finite lattice makes the total knowledge an epoch can yield finite
     * too (ТЗ §5), and makes the reading a property of the place rather than
     * of the wallet standing on it.
     *
     * The hint is computed here and stored as a handle. It is *not* granted
     * to the sender. `collectProbe` is what opens it, after
     * `ReconRules.DELAY_BLOCKS`, so a bot cannot decrypt the answer in the
     * same block it sent the probe. A second send from this wallet before
     * that delay also reverts: reconnaissance costs climb time, not just
     * an allowance.
     */
    function sendProbe(bytes32 lobbyId, uint16 sensorColumn, uint16 sensorRow)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 hintHandle)
    {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.GameParams storage p = $.lobbyParams[lobbyId];

        // The first player to act in the round is also the one who settles
        // the operation's money — see `_activate`. It costs them nothing
        // they were not already paying for, and it means nobody has to have
        // sent a transaction beforehand for the round to be playable.
        _activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();
        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (participant.defenseIndex != 0) revert DefenseAlreadySubmitted();

        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (block.number < attack.launchBlock || block.number >= attack.impactBlock) revert DefenseWindowClosed();

        if (
            participant.lastProbeBlock != 0
                && block.number < uint256(participant.lastProbeBlock) + uint256(ReconRules.DELAY_BLOCKS)
        ) {
            revert ProbeInFlight();
        }

        uint16 owned = $.params.freeProbes + participant.probesPurchased;
        if (participant.probesUsed >= owned) revert NoProbesLeft();

        // The sensor stands on the board the attack is crossing, so the
        // playfield's own grid is the lattice — one shared resolution for
        // where things are, rather than a second one invented for probes.
        GameTypes.GameParams memory epochRules = $.epochParams[attack.epochId];
        if (sensorColumn >= epochRules.gridColumns || sensorRow >= epochRules.gridRows) revert SensorOffBoard();

        participant.probesUsed += 1;
        participant.lastProbeBlock = uint64(block.number);
        // ТЗ §18 — this room woke up. A probe is a real move whether or not a
        // defense ever follows it, and it is what separates an operation that
        // was played and lost (COMPLETED, no refund) from one nobody turned up
        // for (UNPLAYED, everything back). See `GameTypes.Ending`.
        lobby.validActions += 1;
        if (attack.status == GameTypes.AttackStatus.PENDING) attack.status = GameTypes.AttackStatus.LAUNCHED;

        bytes32 sensorKey = keccak256(abi.encode(sensorColumn, sensorRow));
        hintHandle = $.engine.newProbeHint(attack.id, attack.bearingHandle, msg.sender, sensorKey, p.probeConeMicroRad);
        uint64 readableAt = uint64(block.number + uint256(ReconRules.DELAY_BLOCKS));
        $.probeFlights[hintHandle] = GameTypes.ProbeFlight({
            player: msg.sender,
            sentBlock: uint64(block.number),
            readableAtBlock: readableAt,
            granted: false
        });
        emit ProbeSent(lobbyId, msg.sender, attack.id, participant.probesUsed, hintHandle, readableAt);
    }

    /**
     * Open a probe hint after it has been in flight.
     *
     * Permissionless: anybody may collect, and the grant is always to the
     * player who sent the probe. A keeper, a teammate, or the owner
     * themselves are the same call. Reverts until `readableAtBlock`, and
     * reverts if the handle is unknown or already granted.
     *
     * Not paused: this only delivers intelligence the player already paid
     * for, the way `claimReward` delivers a prize that was already won.
     */
    function collectProbe(bytes32 hintHandle) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.ProbeFlight storage flight = $.probeFlights[hintHandle];
        if (flight.player == address(0)) revert UnknownProbe();
        if (flight.granted) revert ProbeAlreadyGranted();
        if (block.number < flight.readableAtBlock) revert ProbeNotReadable();

        $.engine.grantProbeHint(hintHandle, flight.player);
        flight.granted = true;
        emit ProbeHintGranted(hintHandle, flight.player, uint64(block.number));
    }

    /**
     * Send Defense (ТЗ §5).
     *
     * `ciphertext` is the Defense Point, encrypted in the player's browser
     * against the confidential engine. The coordinate is not an argument of
     * this function in any readable form, is not in the event, and cannot be
     * read back out of storage: what the protocol stores is a handle. One
     * defense per participant, ever — a submitted defense is a commitment,
     * and there is no path here that overwrites one.
     */
    function submitDefense(bytes32 lobbyId, bytes calldata ciphertext)
        external
        whenNotPaused
        nonReentrant
        returns (uint32 attemptIndex)
    {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);

        // Same as `sendProbe`: acting in the round is what starts it.
        _activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();
        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (participant.defenseIndex != 0) revert DefenseAlreadySubmitted();

        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (block.number < attack.launchBlock || block.number >= attack.impactBlock) revert DefenseWindowClosed();

        bytes32 pointHandle = $.engine.newEncryptedPoint(ciphertext, msg.sender);

        /*
         * Attempts belong to the team, not to the threat. Every operation
         * running this epoch is aiming at the same object, but each is
         * scored on its own defenders and pays out of its own pool — so one
         * shared list would merge every team in the epoch into a single
         * contest for whichever pool was read first.
         */
        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        list.push();
        attemptIndex = uint32(list.length - 1);
        GameTypes.DefenseAttempt storage attempt = list[attemptIndex];
        attempt.participant = msg.sender;
        attempt.pointHandle = pointHandle;
        attempt.submittedAtBlock = uint64(block.number);
        attempt.submittedAtTimestamp = uint64(block.timestamp);

        participant.defenseIndex = attemptIndex + 1;
        lobby.attemptCount = uint32(list.length);
        // ТЗ §18 — as with a probe: this room played. See `GameTypes.Ending`.
        lobby.validActions += 1;
        if (attack.status == GameTypes.AttackStatus.PENDING) attack.status = GameTypes.AttackStatus.LAUNCHED;

        emit DefenseSubmitted(lobbyId, msg.sender, attack.id, attemptIndex, pointHandle, uint64(block.number));
    }

    // -----------------------------------------------------------------
    // Completion and reveal
    // -----------------------------------------------------------------

    /**
     * The flight is over.
     *
     * Splitting this from the reveal is what makes the reveal permissionless
     * and cheap to retry: this call is the moment the protocol decides the
     * secrecy is no longer needed and asks the engine to unlock decryption,
     * and it can only happen after impact. Until it does, there is no
     * argument anybody can pass to any function that yields a plaintext.
     */
    function completeAttack(uint32 epochId) external nonReentrant {
        _completeAttack(epochId);
    }

    function _completeAttack(uint32 epochId) private {
        GameStorage storage $ = _s();
        GameTypes.Attack storage attack = $.attacks[_epochAttackId(epochId)];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (attack.status == GameTypes.AttackStatus.COMPLETED || attack.status == GameTypes.AttackStatus.RESOLVED) {
            revert WrongAttackStatus();
        }
        if (block.number < attack.impactBlock) revert AttackNotLanded();

        attack.status = GameTypes.AttackStatus.COMPLETED;
        attack.decryptionUnlocked = true;

        /*
         * Only the threat's own two handles are unlocked here. The defense
         * points belong to the teams, and there may be any number of teams
         * on this epoch — gathering every one of their handles into a single
         * call would make the cost of landing an attack grow with how many
         * operations happened to be playing. Each team unlocks its own.
         */
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = attack.bearingHandle;
        handles[1] = attack.deltaHandle;
        $.engine.unlockForReveal(handles);

        emit AttackCompleted(bytes32(0), attack.id, uint64(block.number));
    }

    /**
     * Unlock one team's Defense Points for reading, after the attack landed.
     *
     * The counterpart to `completeAttack` at team scale, and bounded by the
     * team's own size rather than by the epoch's popularity.
     */
    function unlockDefenses(bytes32 lobbyId) external nonReentrant {
        _unlockDefenses(lobbyId);
    }

    function _unlockDefenses(bytes32 lobbyId) private {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (!attack.decryptionUnlocked) revert RevealNotUnlocked();

        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        bytes32[] memory handles = new bytes32[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            handles[i] = list[i].pointHandle;
        }
        $.engine.unlockForReveal(handles);
    }

    /**
     * Reveal (ТЗ §3).
     *
     * The caller brings the plaintexts back with the confidential network's
     * own signatures over them; this contract checks every one against the
     * handle that was fixed when the attack was generated, and only then
     * does the geometry become protocol state. A caller who invents a
     * coordinate fails the check, and a caller who submits the true one
     * cannot choose *which* true one — the handles were committed before
     * anybody had ever seen a probe.
     *
     * The first successful call publishes for everyone and decides the
     * winner; there is no second reveal to make, and every later attempt is
     * rejected rather than re-run.
     */
    function revealEpochAttack(
        uint32 epochId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof
    ) external nonReentrant {
        _revealEpochAttack(epochId, bearingProof, deltaProof);
    }

    function _revealEpochAttack(
        uint32 epochId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof
    ) private {
        GameStorage storage $ = _s();
        GameTypes.Attack storage attack = $.attacks[_epochAttackId(epochId)];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if ($.revealed[attack.id]) revert AlreadyRevealed();
        if (!attack.decryptionUnlocked) revert RevealNotUnlocked();
        if (attack.status != GameTypes.AttackStatus.COMPLETED) revert WrongAttackStatus();

        IConfidentialEngine engine = $.engine;
        if (!engine.verifyDecryption(attack.bearingHandle, bearingProof.value, bearingProof.signatures)) {
            revert InvalidDecryptionProof(0);
        }
        if (!engine.verifyDecryption(attack.deltaHandle, deltaProof.value, deltaProof.signatures)) {
            revert InvalidDecryptionProof(1);
        }
        if (
            bearingProof.value > uint256(2 * Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD)
                || deltaProof.value > uint256(2 * Geometry.MAX_IMPACT_DELTA_MICRO_RAD)
        ) {
            revert InvalidDecryptionProof(0);
        }

        GameTypes.GameParams memory p = $.epochParams[epochId];
        Geometry.World memory world = Geometry.buildWorld(p.gridColumns, p.gridRows, p.sectorSpanKm);
        GameTypes.Trajectory memory traj =
            Geometry.deriveTrajectory(world, bearingProof.value, deltaProof.value, attack.flightBlocks);

        $.trajectories[attack.id] = traj;
        $.revealed[attack.id] = true;
        attack.status = GameTypes.AttackStatus.RESOLVED;

        emit AttackRevealed(bytes32(0), attack.id, msg.sender, traj, uint64(block.number));
    }

    /**
     * Score one team against the epoch's published trajectory.
     *
     * Separate from the reveal because they answer different questions. The
     * reveal is about the world: where the threat actually went, published
     * once, for everyone, by whoever gets there first. This is about one
     * team: which of *its* defenders reached the line in time, and who takes
     * *its* pool. Two operations on the same epoch resolve independently and
     * can both have winners — they were never competing for the same money.
     *
     * It also keeps each call bounded by a team's size rather than by how
     * many operations the epoch happened to attract.
     */
    function resolveLobby(bytes32 lobbyId, GameTypes.DecryptionProof[] calldata defenseProofs) external nonReentrant {
        _resolveLobby(lobbyId, defenseProofs);
    }

    function _resolveLobby(bytes32 lobbyId, GameTypes.DecryptionProof[] calldata defenseProofs) private {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if (!$.revealed[attack.id]) revert RevealNotUnlocked();
        /*
         * An operation whose defenders never sent anything is still an
         * operation the epoch attacked, and it still owes its creator a fee
         * and its pool a destination. Nobody activated it, so the reveal
         * does — otherwise a team that watched the attack land without
         * acting could never be scored at all.
         */
        _activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();

        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        if (defenseProofs.length != list.length) revert ProofCountMismatch();

        GameTypes.GameParams memory p = $.epochParams[attack.epochId];
        Geometry.World memory world = Geometry.buildWorld(p.gridColumns, p.gridRows, p.sectorSpanKm);

        Resolution.Context memory ctx = Resolution.Context({
            world: world,
            traj: $.trajectories[attack.id],
            radiusWu: Geometry.interceptRadiusWu(world, p.interceptRadiusMilliSectors),
            launchBlock: attack.launchBlock,
            flightBlocks: attack.flightBlocks,
            defenseSpeed: p.defenseSpeedKmPerBlock
        });

        GameTypes.Outcome storage outcome = $.outcomes[lobbyId];
        Resolution.resolve($.engine, list, outcome, ctx, defenseProofs);

        outcome.interceptRadiusWu = ctx.radiusWu;
        outcome.resolvedAtBlock = uint64(block.number);
        outcome.resolvedAtTimestamp = uint64(block.timestamp);
        outcome.revealedBy = msg.sender;

        uint256 winnerCount = outcome.winners.length;
        if (winnerCount > 0) {
            outcome.intercepted = true;
            outcome.rewardPerWinner = uint256(lobby.rewardPool) / winnerCount;
            /*
             * The planet is saved if *any* team stopped the threat, so this
             * counts attacks rather than teams — and only the first team to
             * manage it moves the number.
             */
            if (!attack.intercepted) {
                attack.intercepted = true;
                unchecked {
                    $.interceptedAttacks += 1;
                }
            }
        }

        /*
         * ТЗ §18 — which of the three endings this was, decided here and
         * nowhere else.
         *
         * A team that never took an action is not a team that lost. It is a
         * room the attack flew over: no probe was sent, no defense was
         * submitted, and there was no contest for the pool to be the prize of.
         * Scoring it as a defeat and keeping the money would be charging
         * people for a game that never started, so it ends UNPLAYED and
         * everything goes back — which also means it must leave in the
         * refundable state rather than in RESOLVED.
         *
         * Everything else is COMPLETED, interception or not.
         */
        if (lobby.validActions == 0) {
            lobby.ending = GameTypes.Ending.UNPLAYED;
            lobby.status = GameTypes.LobbyStatus.CANCELLED;
            _releaseProtocolFees($, lobby);
            emit LobbyCancelled(lobbyId, "no defender ever acted");
        } else {
            lobby.ending = GameTypes.Ending.COMPLETED;
            lobby.status = GameTypes.LobbyStatus.RESOLVED;
            /*
             * Nobody stopped it, so nobody in this operation earned its pool —
             * and it does not go home to the creator either (ТЗ §17). It goes
             * to the Global Defense Pool, to be played for by everyone at the
             * next draw. A bounty that comes back on a miss is a bounty that
             * costs nothing to advertise, which is what the rule this replaces
             * was quietly funding.
             *
             * `rewardPool` is zeroed as the money leaves, so the pool balance
             * and the operations' balances never double-count the same wei —
             * `creatorDue`'s dust branch reads `rewardPool` too.
             */
            if (winnerCount == 0 && lobby.rewardPool > 0) {
                uint256 forfeited = lobby.rewardPool;
                lobby.rewardPool = 0;
                $.globalDefensePool += forfeited;
                emit DefensePoolFunded(lobbyId, forfeited, $.globalDefensePool);
            }
        }
        if ($.activeLobbies > 0) $.activeLobbies -= 1;

        emit WinnerDetermined(
            lobbyId,
            attack.id,
            outcome.intercepted,
            outcome.winners,
            outcome.rewardPerWinner,
            outcome.winningArrivalBlockScaled
        );

        // A miss that lands inside the join window funds the pool and can
        // open the draw in the same transaction — nobody has to click a
        // trophy for the jackpot to become a lobby.
        Lobbies.maybeOpenDraw($);
    }

    // -----------------------------------------------------------------
    // The reveal, in two calls instead of four
    // -----------------------------------------------------------------

    /**
     * Why a reveal is two transactions, and why it cannot be one.
     *
     * The four steps above are the protocol's own decomposition and none of
     * them is redundant, but the *caller* has to send all four, and each one
     * opens a wallet. Four prompts to find out whether you won is a bad
     * enough experience that players stop finishing rounds, and it is the
     * client — not the protocol — that pays for the split.
     *
     * What forces at least two is the confidential network standing between
     * them. Each pair is unlock-then-prove: the contract must first tell the
     * engine a handle may be opened, that unlock must be *mined* so the
     * covalidator quorum can see it, and only then will the quorum sign the
     * plaintext the second call brings back for verification. There is no
     * ordering of these four in a single transaction that gets a signature
     * over a value nobody has been allowed to decrypt yet.
     *
     * But the two *unlocks* need nothing from each other, and neither do the
     * two *proofs* — so the epoch's half and the team's half fold together
     * along that seam. `unlockRound` performs step 1 and step 3;
     * `revealAndResolve` performs step 2 and step 4, with all the attested
     * plaintexts fetched in one round trip between them.
     *
     * Both are idempotent for exactly the reason the four are: a reveal is
     * permissionless, several clients race to send it, and losing that race
     * is the ordinary outcome rather than a failure. Each half skips what
     * somebody else has already done rather than reverting on it, so a team
     * whose epoch was revealed by another operation pays only for its own
     * scoring. The four originals stay exactly as they were — a caller that
     * wants to take one step at a time still can, and every existing test
     * and script keeps working.
     */
    function unlockRound(bytes32 lobbyId) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (attack.id == bytes32(0)) revert UnknownAttack();

        // Landing the attack is the epoch's business and usually already
        // done by another operation on the same epoch.
        if (!attack.decryptionUnlocked) _completeAttack(attack.epochId);
        // Safe to repeat: unlocking a handle that is already unlocked is a
        // no-op at the engine, which is what lets this be called blind.
        _unlockDefenses(lobbyId);
    }

    /**
     * The second half: publish the epoch's geometry and score this team.
     *
     * `defenseProofs` must still be one proof per attempt in order — that is
     * `resolveLobby`'s rule and it is unchanged. The proofs are ignored
     * entirely when the team has already been scored, so a client that
     * fetched them and then lost the race wastes a fetch rather than a
     * transaction.
     */
    function revealAndResolve(
        bytes32 lobbyId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof,
        GameTypes.DecryptionProof[] calldata defenseProofs
    ) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (attack.id == bytes32(0)) revert UnknownAttack();

        if (!$.revealed[attack.id]) _revealEpochAttack(attack.epochId, bearingProof, deltaProof);

        /*
         * Scored-ness is read off the outcome rather than off the lobby's
         * status, and the difference matters. `_resolveLobby` can leave a
         * lobby in RESOLVED *or* in CANCELLED — a team where nobody ever
         * acted ends UNPLAYED and refundable — so a status test would have to
         * enumerate the endings and would silently start re-entering
         * `_resolveLobby` the day a new one is added. `resolvedAtBlock` is
         * written by that function and by nothing else.
         */
        if ($.outcomes[lobbyId].resolvedAtBlock == 0) _resolveLobby(lobbyId, defenseProofs);
    }

    /**
     * Nobody revealed, and the grace period is over.
     *
     * Without this an operation whose reveal never happened would hold its
     * players' money forever. It cannot be used to escape a lost round: it
     * only opens after the attack has landed *and* the grace window has
     * passed, and it pays nobody a reward — every participant simply takes
     * back what they paid in, and the creator takes back the bounty.
     */
    function expireAttack(bytes32 lobbyId) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        GameTypes.GameParams storage p = $.lobbyParams[lobbyId];

        if (attack.id == bytes32(0)) revert UnknownAttack();
        if ($.revealed[attack.id] || $.expired[attack.id]) revert AlreadyRevealed();
        if (block.number < uint256(attack.impactBlock) + uint256(p.revealGraceBlocks)) revert AttackNotLanded();

        $.expired[attack.id] = true;
        attack.status = GameTypes.AttackStatus.RESOLVED;
        lobby.status = GameTypes.LobbyStatus.CANCELLED;
        /*
         * ТЗ §18 — CANCELLED, and specifically not UNPLAYED.
         *
         * Everybody here may well have played: probes were sent, defenses were
         * submitted, and the round was fought. What failed is the protocol's
         * half of it — the geometry was never published, so there is no
         * trajectory to score anybody against and no honest way to name a
         * winner. That is our failure rather than the room's, and the two
         * deserve different names even though they pay out identically.
         */
        lobby.ending = GameTypes.Ending.CANCELLED;
        if ($.activeLobbies > 0) $.activeLobbies -= 1;

        _releaseProtocolFees($, lobby);

        emit AttackExpired(lobbyId, attack.id, "no reveal within grace period");
        emit LobbyCancelled(lobbyId, "no reveal within grace period");
    }

    /**
     * Gives the treasury back an operation's seat fees.
     *
     * Protocol fees become the treasury's when an operation activates. An
     * ending that refunds — UNPLAYED or CANCELLED — pays every participant
     * back everything they put in, seat fee included, so the treasury has to
     * give up what it was credited or an owner withdrawal could leave the
     * contract unable to pay refunds it has already promised.
     *
     * Clamped rather than trusted: an operation cancelled before it ever
     * activated was never credited to the treasury in the first place.
     */
    function _releaseProtocolFees(GameStorage storage $, GameTypes.Lobby storage lobby) private {
        if ($.protocolTreasury >= lobby.protocolFeeAccrued) {
            $.protocolTreasury -= lobby.protocolFeeAccrued;
        } else {
            $.protocolTreasury = 0;
        }
    }

    // -----------------------------------------------------------------
    // Payouts
    // -----------------------------------------------------------------

    /**
     * Claim Reward.
     *
     * A write, and never a read the frontend could imitate: the reward moves
     * only after the protocol has re-checked the operation, the reveal, the
     * interception, the ranking and the not-already-claimed flag. Deciding
     * on a client that somebody won changes nothing here.
     */
    function claimReward(bytes32 lobbyId) external nonReentrant returns (uint256 amount) {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.RESOLVED) revert WrongLobbyStatus();

        GameTypes.Outcome storage outcome = $.outcomes[lobbyId];
        if (!outcome.intercepted) revert NothingToClaim();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (participant.claimed) revert AlreadyClaimed();
        if (participant.defenseIndex == 0) revert NothingToClaim();

        GameTypes.DefenseAttempt storage attempt = $.attempts[lobbyId][participant.defenseIndex - 1];
        if (!attempt.isWinner) revert NothingToClaim();

        amount = outcome.rewardPerWinner;
        participant.claimed = true;
        lobby.rewardsClaimed += uint128(amount);

        _pay(payable(msg.sender), amount);
        emit RewardClaimed(lobbyId, msg.sender, amount);
    }

    /**
     * The money back, in the two endings that owe any (ТЗ §18).
     *
     * UNPLAYED and CANCELLED both return everything a wallet paid in — entry,
     * seat fee and probes alike — because in neither case was a round
     * delivered. What separates them is *whose* failure it was, not what is
     * owed: nobody turned up, or the protocol could not run the game.
     *
     * COMPLETED owes nothing, and that is a deliberate change from the rule
     * this replaces. That one refunded the entry money whenever the threat got
     * through, which made losing very nearly free and an entry fee not really
     * a stake at all. A round that ran was delivered; the pool goes to whoever
     * intercepted, and if nobody did it goes to the Global Defense Pool.
     */
    function claimRefund(bytes32 lobbyId) external nonReentrant returns (uint256 amount) {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (participant.refunded) revert AlreadyClaimed();

        amount = Settlement.refundDue(lobby.ending, participant);
        if (amount == 0) revert NothingToClaim();

        participant.refunded = true;
        _pay(payable(msg.sender), amount);
        emit RefundClaimed(lobbyId, msg.sender, amount);
    }

    /**
     * The creator's settlement, in one call whatever the outcome.
     *
     * The Creator Fee is paid on a hit and on a miss alike — a creator is paid
     * for filling an operation, not for its result. The bounty comes back only
     * when the operation never ran; on a COMPLETED round it stays in the pool
     * and follows the pool, to the winners or to the Global Defense Pool.
     */
    function settleCreator(bytes32 lobbyId) external nonReentrant returns (uint256 amount) {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        if (lobby.creatorSettled) revert AlreadyClaimed();
        if (lobby.ending == GameTypes.Ending.NONE) revert WrongLobbyStatus();

        /*
         * The seat fee the creator actually paid, which is not always the
         * params' figure: the protocol's own draw operation is minted with no
         * seat fee at all (charging itself a fee it also collects would be
         * moving money between its own pockets). Reading the parameter here
         * regardless would refund a fee that was never paid, and every draw
         * that ended UNPLAYED would leave the contract short by exactly one
         * seat.
         */
        uint256 creatorSeatFee = lobby.creator == address(this) ? 0 : $.lobbyParams[lobbyId].protocolJoinFee;
        amount = Settlement.creatorDue(lobby, $.lobbyConfigs[lobbyId], $.outcomes[lobbyId], creatorSeatFee);
        lobby.creatorSettled = true;
        if (amount == 0) revert NothingToClaim();

        /*
         * The protocol's own draw operation settles back into the pool rather
         * than paying an address.
         *
         * A Global Defense operation is created by this contract, so its
         * "creator" is this contract, and there is nobody to send a bounty to.
         * When such an operation ends UNPLAYED or CANCELLED the money it was
         * holding is the pool's — it came from there — so it goes straight
         * back and waits for the next draw. This is the second half of the
         * rule that already covers a draw nobody wins, and it is
         * permissionless for the same reason: the money must be able to find
         * its way home without the owner being online (ТЗ §18).
         */
        if (lobby.creator == address(this)) {
            $.globalDefensePool += amount;
            emit DefensePoolFunded(lobbyId, amount, $.globalDefensePool);
            return amount;
        }

        if (msg.sender != lobby.creator) revert NotCreator();
        _pay(payable(lobby.creator), amount);
        emit CreatorSettled(lobbyId, lobby.creator, amount);
    }

    // -----------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------

    /**
     * Everything a client reads lives on `AegylaxLens`, and everything it
     * writes lives here.
     *
     * The split is a size constraint turned into a boundary worth having.
     * A contract this size does not fit in one deployed code object, and of
     * the two halves the read half is the one that can move without
     * weakening anything: the lens runs by `delegatecall` in the proxy's own
     * storage context, so it sees exactly the state this contract wrote, it
     * has no privileged entry point of its own, and every state-changing
     * function stays in this file where it can be audited as a whole.
     *
     * Clients see one address with one merged ABI, which is what the
     * generated frontend config ships.
     */
    function setLens(address lens_) external onlyOwner {
        _s().lens = lens_;
        emit LensUpdated(lens_);
    }

    function getLens() external view returns (address) {
        return _s().lens;
    }

    fallback() external {
        address lens = _s().lens;
        if (lens == address(0)) revert UnknownSelector();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), lens, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------

    function _lobby(GameStorage storage $, bytes32 lobbyId)
        private
        view
        returns (GameTypes.Lobby storage lobby)
    {
        lobby = $.lobbies[lobbyId];
        if (lobby.status == GameTypes.LobbyStatus.NONE) revert UnknownLobby();
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
