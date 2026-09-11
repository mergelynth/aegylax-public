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
import {Settlement} from "./libraries/Settlement.sol";
import {Geometry} from "./libraries/Geometry.sol";
import {Lobbies} from "./libraries/Lobbies.sol";
import {ReconRules} from "./libraries/ReconRules.sol";
import {Scoring} from "./libraries/Scoring.sol";

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
    /// A Defense Point may not be locked in until the last probe's delay is served.
    error DefenseLockedByProbe();
    error ProbeNotReadable();
    error UnknownProbe();
    error ProbeAlreadyGranted();
    error DefenseAlreadySubmitted();
    error DefenseWindowClosed();
    error AttackNotLanded();
    error AlreadyRevealed();
    error RevealNotUnlocked();
    error InvalidDecryptionProof(uint256 index);
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
        return "1.8.0";
    }

    /**
     * Geometry + attestation per attempt, not FHE ACL, is what bounds a scoring
     * transaction. Thirty-two sits under Base's 16.7M tx cap with headroom.
     */
    uint256 public constant MAX_SCORE_BATCH = Scoring.MAX_BATCH;

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
         * The protocol's fee is charged once, at creation, and it is never
         * refunded. Joiners pay the author, not the protocol: their extra
         * is `creatorFeeBps` of the entry, held until the round starts or
         * given back if it does not. The creation fee is the treasury's
         * from this moment, so a cancelled room cannot claw it back.
         */
        if (msg.value != uint256(config.startPrizePool) + uint256(p.protocolJoinFee)) revert IncorrectPayment();

        lobbyId = Lobbies.mintLobby($, p, config, msg.sender, p.protocolJoinFee);
        $.protocolTreasury += p.protocolJoinFee;
    }

    function joinLobby(bytes32 lobbyId) external payable whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.LobbyConfig storage config = $.lobbyConfigs[lobbyId];

        if (lobby.status != GameTypes.LobbyStatus.OPEN) revert WrongLobbyStatus();
        // The block, not the timestamp: it is the deadline the attack was
        // scheduled from, so it is the one a seat has to be taken before.
        if (block.number >= config.registrationDeadlineBlock) revert RegistrationClosed();
        if (lobby.participantCount >= config.maxPlayers) revert LobbyFull();

        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (participant.joined) revert AlreadyJoined();

        /*
         * Join is the entry plus the author's commission. The protocol's
         * own draw mints with `creatorFeeBps == 0`, so sitting in the
         * jackpot is free. The commission is the author's if the round
         * starts, and the joiner's again if it does not.
         */
        uint256 commission = Settlement.authorCommission(config.entryPrice, config.creatorFeeBps);
        uint256 cost = uint256(config.entryPrice) + commission;
        if (msg.value != cost) revert IncorrectPayment();

        participant.joined = true;
        participant.joinedAtBlock = uint64(block.number);
        participant.paidIn = uint128(cost);

        $.lobbyParticipants[lobbyId].push(msg.sender);
        lobby.participantCount += 1;
        lobby.entryFeesCollected += config.entryPrice;
        lobby.creatorFeeAccrued += uint128(commission);

        emit PlayerJoined(lobbyId, msg.sender, cost, lobby.participantCount);
    }

    /**
     * Leave before the operation starts (ТЗ §2).
     *
     * Legal only while applications are open: once the attack is scheduled
     * the seat is committed, and a defender who could withdraw afterwards
     * would be able to watch the reconnaissance and take their money back.
     *         What comes out is exactly what went in — entry, the author's
     * commission and any probes bought — because nothing has been consumed yet.
     */
    function leaveLobby(bytes32 lobbyId) external nonReentrant {
        Lobbies.leave(_s(), lobbyId);
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
        Lobbies.maybeOpenDraw($);
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
     * is settled by whichever transaction needs it first (`Lobbies.activate`). The
     * function stays because the transition is worth being able to trigger
     * deliberately, and because an operation whose players never act still
     * has to be able to reach ACTIVE before it can be scored.
     */
    function startOperation(bytes32 lobbyId) external whenNotPaused nonReentrant {
        GameStorage storage $ = _s();
        _lobby($, lobbyId);
        Lobbies.activate($, lobbyId);
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
        GameStorage storage $ = _s();
        // Close a leftover under-filled room first so the next interval
        // can mint without that lobby still sitting OPEN.
        Lobbies.maybeCloseDraw($);
        return Lobbies.openDraw($);
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

        Lobbies.closeUnfilled($, lobbyId);
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
     * The hint is computed *and granted* here, in this one transaction.
     *
     * `ReconRules.DELAY_BLOCKS` used to sit between the two halves — the
     * hint was computed here and opened by a separate `collectProbe` — so
     * that a bot could not decrypt the answer in the same block it sent the
     * probe. The delay is still exactly `DELAY_BLOCKS` long, but it now
     * gates the two calls that can *spend* a reading rather than the read
     * itself: this one (a second probe) and `submitDefense` (a Defense
     * Point). A bot that reads early therefore gains nothing it can act on,
     * and reconnaissance still costs climb time and not just an allowance.
     *
     * What the split cost was paid by everybody who was not a bot: a second
     * wallet signature, and a second round trip through the confidential
     * network's ingestion — it has to see a transaction before the handle it
     * touched will open, and granting in a later transaction made every
     * player wait for that twice.
     */
    function sendProbe(bytes32 lobbyId, uint16 sensorColumn, uint16 sensorRow)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 hintHandle)
    {
        GameStorage storage $ = _s();
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.GameParams storage p = $.lobbyParams[lobbyId];

        // The first player to act in the round is also the one who settles
        // the operation's money — see `Lobbies.activate`. It costs them nothing
        // they were not already paying for, and it means nobody has to have
        // sent a transaction beforehand for the round to be playable.
        Lobbies.activate($, lobbyId);
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
        hintHandle = $.engine.newProbeHint(
            attack.id, attack.bearingHandle, attack.deltaHandle, msg.sender, sensorKey, p.probeConeMicroRad
        );
        // Readable now: `newProbeHint` granted it to `msg.sender` above.
        // The flight is still recorded, because it is what `collectProbe`
        // and the Lens read, and what makes a probe whose grant was somehow
        // lost repairable rather than paid-for and gone.
        uint64 readableAt = uint64(block.number);
        $.probeFlights[hintHandle] = GameTypes.ProbeFlight({
            player: msg.sender,
            sentBlock: uint64(block.number),
            readableAtBlock: readableAt,
            granted: true
        });
        emit ProbeSent(lobbyId, msg.sender, attack.id, participant.probesUsed, hintHandle, readableAt);
    }

    /**
     * Re-open a probe hint whose grant did not stick.
     *
     * `sendProbe` grants the hint to its sender in the same transaction, so
     * on the normal path there is nothing here to do and this reverts with
     * `ProbeAlreadyGranted`. It stays for two reasons: a probe sent by an
     * engine deployed before that change still needs collecting, and the
     * ACL belongs to the confidential network — re-asserting a grant is the
     * only repair available if one is ever lost, and it must not require the
     * player to own the probe to ask for it.
     *
     * Permissionless: anybody may collect, and the grant is always to the
     * player who sent the probe. A keeper, a teammate, or the owner
     * themselves are the same call.
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
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);

        // Same as `sendProbe`: acting in the round is what starts it.
        Lobbies.activate($, lobbyId);
        if (lobby.status != GameTypes.LobbyStatus.ACTIVE) revert WrongLobbyStatus();
        GameTypes.Participant storage participant = $.participants[lobbyId][msg.sender];
        if (!participant.joined) revert NotParticipant();
        if (participant.defenseIndex != 0) revert DefenseAlreadySubmitted();

        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (block.number < attack.launchBlock || block.number >= attack.impactBlock) revert DefenseWindowClosed();

        /*
         * The other half of `ReconRules.DELAY_BLOCKS`, and the reason a probe
         * can be read in the block that paid for it.
         *
         * Reconnaissance has to cost time, not just an allowance: reading a
         * hint and locking a Defense Point off it in the next block is the
         * line a bot farm would run. Blocking it *here* is the direct
         * statement of that rule — a reading cannot be spent for
         * `DELAY_BLOCKS` after the probe that produced it — where the old
         * placement (withholding the decryption) only implied it, and made
         * every honest player pay a second transaction for the implication.
         *
         * A player who never probed is not held up by anything.
         */
        if (
            participant.lastProbeBlock != 0
                && block.number < uint256(participant.lastProbeBlock) + uint256(ReconRules.DELAY_BLOCKS)
        ) {
            revert DefenseLockedByProbe();
        }

        bytes32 pointHandle = $.engine.newEncryptedPoint(ciphertext, msg.sender);
        bytes32 maskedHandle = $.engine.maskDefensePoint(pointHandle, attack.maskKeyHandle);

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
        attempt.maskedHandle = maskedHandle;
        attempt.submittedAtBlock = uint64(block.number);
        attempt.submittedAtTimestamp = uint64(block.timestamp);

        participant.defenseIndex = attemptIndex + 1;
        lobby.attemptCount = uint32(list.length);
        // ТЗ §18 — as with a probe: this room played. See `GameTypes.Ending`.
        lobby.validActions += 1;
        if (attack.status == GameTypes.AttackStatus.PENDING) attack.status = GameTypes.AttackStatus.LAUNCHED;

        emit DefenseSubmitted(
            lobbyId, msg.sender, attack.id, attemptIndex, pointHandle, maskedHandle, uint64(block.number)
        );
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
         * θ, δ and the one-time pad. Defense Points are not in this list:
         * each one published its pad `M` at submit, and `M` is already
         * globally readable. Unlocking `K` here is what makes every `P`
         * a clear subtraction, for the whole epoch, in O(1).
         */
        bytes32[] memory handles = new bytes32[](3);
        handles[0] = attack.bearingHandle;
        handles[1] = attack.deltaHandle;
        handles[2] = attack.maskKeyHandle;
        $.engine.unlockForReveal(handles);

        emit AttackCompleted(bytes32(0), attack.id, uint64(block.number));
    }

    /**
     * Kept so existing clients that still send it do not revert. Defense
     * Points are not unlocked here: their pads were made public at submit,
     * and `completeAttack` unlocks the one key that unmasks every one of them.
     */
    function unlockDefenses(bytes32 lobbyId) external view {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        if ($.attacks[lobby.attackId].id == bytes32(0)) revert UnknownAttack();
        if (!$.attacks[lobby.attackId].decryptionUnlocked) revert RevealNotUnlocked();
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
     * Publishing θ, δ and `K` is what makes the map drawable: `K` unmasks
     * every Defense Point whose pad was already public. Scoring — who won
     * this team's pool — is a separate call, because it walks attempts and
     * must not be coupled to the epoch's one-time publish.
     */
    function revealEpochAttack(
        uint32 epochId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof,
        GameTypes.DecryptionProof calldata maskProof
    ) external nonReentrant {
        _revealEpochAttack(epochId, bearingProof, deltaProof, maskProof);
    }

    function _revealEpochAttack(
        uint32 epochId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof,
        GameTypes.DecryptionProof calldata maskProof
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
        if (!engine.verifyDecryption(attack.maskKeyHandle, maskProof.value, maskProof.signatures)) {
            revert InvalidDecryptionProof(2);
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
        $.publishedMaskKeys[attack.id] = maskProof.value;
        $.maskPublished[attack.id] = true;
        attack.status = GameTypes.AttackStatus.RESOLVED;

        emit AttackRevealed(bytes32(0), attack.id, msg.sender, traj, uint64(block.number));
    }

    /**
     * Score one team against the epoch's published trajectory.
     *
     * Separate from the reveal because they answer different questions. The
     * reveal is about the world: where the threat actually went, and the
     * one-time pad that unmasks every Defense Point, published once for
     * everyone. This is about one team: which of *its* defenders reached the
     * line in time, and who takes *its* pool. Two operations on the same
     * epoch resolve independently and can both have winners — they were
     * never competing for the same money.
     *
     * Rooms that fit in `MAX_SCORE_BATCH` may be scored in this one call.
     * Larger rooms use `proveDefenses` in chunks, then `finalizeScoring`.
     */
    function resolveLobby(bytes32 lobbyId, GameTypes.DecryptionProof[] calldata defenseProofs) external nonReentrant {
        Scoring.resolveAll(_s(), lobbyId, defenseProofs);
    }

    /**
     * Attest a subset of this team's Defense Points and recrown.
     *
     * Permissionless. A winner who the keeper has not yet scored can prove
     * their own hit; anybody can submit a better one before finalize. Money
     * does not move until `finalizeScoring`.
     */
    function proveDefenses(
        bytes32 lobbyId,
        uint32[] calldata indices,
        GameTypes.DecryptionProof[] calldata proofs
    ) external nonReentrant {
        Scoring.prove(_s(), lobbyId, indices, proofs);
    }

    /**
     * Assign this team's pool. Requires every attempt scored, or the reveal
     * grace window to have passed (unscored attempts are then misses).
     */
    function finalizeScoring(bytes32 lobbyId) external nonReentrant {
        Scoring.finalizeIfReady(_s(), lobbyId);
    }

    // -----------------------------------------------------------------
    // The reveal, in two calls instead of four
    // -----------------------------------------------------------------

    /**
     * Why a reveal is two transactions, and why it cannot be one.
     *
     * Unlocking decryption is an on-chain transaction, but the confidential
     * network learns about it by watching the chain. The three epoch
     * handles — θ, δ, `K` — have to be unlocked, mined, and only then
     * attested. There is no ordering of those two halves in a single
     * transaction that gets a signature over a value nobody has been
     * allowed to decrypt yet.
     *
     * Defense Points are not in that unlock. Their pads were public from
     * submit; unlocking `K` is what makes every `P` a clear subtraction.
     *
     * `unlockRound` lands the attack. `revealAndResolve` publishes the
     * geometry and, when the team fits in one batch, scores it. Larger
     * rooms publish with an empty defense list, then `proveDefenses` /
     * `finalizeScoring`.
     *
     * Both are idempotent: a reveal is permissionless, several clients race
     * to send it, and losing that race is the ordinary outcome rather than
     * a failure.
     */
    function unlockRound(bytes32 lobbyId) external nonReentrant {
        GameStorage storage $ = _s();
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (attack.id == bytes32(0)) revert UnknownAttack();

        if (!attack.decryptionUnlocked) _completeAttack(attack.epochId);
    }

    /**
     * The second half: publish the epoch's geometry and, when the proofs
     * cover the whole team in one batch, score it.
     *
     * An empty `defenseProofs` on a team that has attempts publishes the
     * map and leaves scoring to `proveDefenses`. That is the display path:
     * the trajectory and `K` are public, every pad is already public, and
     * the frontend does not wait for every attempt to be judged.
     */
    function revealAndResolve(
        bytes32 lobbyId,
        GameTypes.DecryptionProof calldata bearingProof,
        GameTypes.DecryptionProof calldata deltaProof,
        GameTypes.DecryptionProof calldata maskProof,
        GameTypes.DecryptionProof[] calldata defenseProofs
    ) external nonReentrant {
        GameStorage storage $ = _s();
        Lobbies.maybeOpenDraw($);
        GameTypes.Lobby storage lobby = _lobby($, lobbyId);
        GameTypes.Attack storage attack = $.attacks[lobby.attackId];
        if (attack.id == bytes32(0)) revert UnknownAttack();

        if (!$.revealed[attack.id]) {
            _revealEpochAttack(attack.epochId, bearingProof, deltaProof, maskProof);
        }

        if ($.outcomes[lobbyId].resolvedAtBlock != 0) return;

        GameTypes.DefenseAttempt[] storage list = $.attempts[lobbyId];
        if (defenseProofs.length == list.length) {
            if (list.length > MAX_SCORE_BATCH) revert Scoring.ScoringBatchTooLarge();
            Scoring.resolveAll($, lobbyId, defenseProofs);
            return;
        }
        if (defenseProofs.length == 0 && list.length > 0) return;
        revert Scoring.ProofCountMismatch();
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

        emit AttackExpired(lobbyId, attack.id, "no reveal within grace period");
        emit LobbyCancelled(lobbyId, "no reveal within grace period");
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
     *
     * When the caller is also the creator, the Creator Fee is paid on this
     * same call so they are not left on a second button.
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

        uint256 prize = outcome.rewardPerWinner;
        participant.claimed = true;
        lobby.rewardsClaimed += uint128(prize);

        /*
         * A creator who also won is owed the fee on the same button as the
         * prize. Paying it here keeps them off a second claim after every
         * other winner has already been paid. `settleCreator` still exists
         * for a creator who did not intercept, and for a leftover call.
         */
        uint256 fee;
        if (msg.sender == lobby.creator && !lobby.creatorSettled) {
            fee = Settlement.creatorDue(lobby, $.lobbyConfigs[lobbyId], outcome);
            if (fee > 0) {
                lobby.creatorSettled = true;
            }
        }

        amount = prize + fee;
        _pay(payable(msg.sender), amount);
        emit RewardClaimed(lobbyId, msg.sender, prize);
        if (fee > 0) emit CreatorSettled(lobbyId, lobby.creator, fee);
    }

    /**
     * The money back, in the two endings that owe any (ТЗ §18).
     *
     * UNPLAYED and CANCELLED both return everything a wallet paid in — entry,
     * the author's commission and probes alike — because in neither case was a
     * round delivered. The creator is on this same call: the bounty they
     * funded comes back here. The protocol fee they paid at mint does not.
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
        if (participant.joined && !participant.refunded) {
            uint256 defenderDue = Settlement.refundDue(lobby.ending, participant);
            if (defenderDue > 0) {
                amount += defenderDue;
                participant.refunded = true;
            }
        }

        if (msg.sender == lobby.creator && !lobby.creatorSettled) {
            uint256 creatorLaunch = Settlement.creatorRefundDue(lobby.ending, $.lobbyConfigs[lobbyId]);
            if (creatorLaunch > 0) {
                amount += creatorLaunch;
                lobby.creatorSettled = true;
                emit CreatorSettled(lobbyId, lobby.creator, creatorLaunch);
            }
        }

        if (amount == 0) {
            if (msg.sender == lobby.creator && lobby.creatorSettled && (!participant.joined || participant.refunded)) {
                revert AlreadyClaimed();
            }
            if (!participant.joined) revert NotParticipant();
            if (participant.refunded) revert AlreadyClaimed();
            revert NothingToClaim();
        }

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

        amount = Settlement.creatorDue(lobby, $.lobbyConfigs[lobbyId], $.outcomes[lobbyId]);
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

    function _pay(address payable to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
