// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AegylaxGame} from "../src/AegylaxGame.sol";
import {AegylaxLens} from "../src/AegylaxLens.sol";
import {MockConfidentialEngine} from "../src/confidential/MockConfidentialEngine.sol";
import {GameTypes} from "../src/libraries/GameTypes.sol";
import {Geometry} from "../src/libraries/Geometry.sol";
import {ReconRules} from "../src/libraries/ReconRules.sol";

/**
 * Shared harness: a proxied game, a lens, and a mock confidential engine,
 * plus the small vocabulary every test needs (create an operation, fill it,
 * fly the attack, reveal it).
 *
 * Everything here goes through the same entry points a player's wallet
 * would. There is no test-only backdoor into the protocol — the only thing
 * the harness knows that a player does not is what the mock engine drew,
 * and it only uses that to compute what the *expected* answer is.
 */
abstract contract AegylaxTest is Test {
    AegylaxGame internal game;
    AegylaxLens internal lens;
    MockConfidentialEngine internal engine;

    address internal owner = address(0xA11CE);
    address internal creator = address(0xC1EA);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);

    uint128 internal constant ENTRY = 0.01 ether;
    uint128 internal constant POOL = 0.05 ether;
    uint128 internal constant PROBE_PRICE = 0.002 ether;
    uint64 internal constant REGISTRATION = 1 days;
    /// The same window in the unit the protocol actually enforces.
    uint64 internal constant REGISTRATION_BLOCKS = 50;
    /// Epochs between Global Defense draws, in tests.
    uint32 internal constant DRAW_INTERVAL = 10;

    function setUp() public virtual {
        vm.roll(1000);
        vm.warp(1_700_000_000);

        engine = new MockConfidentialEngine(owner);
        AegylaxGame implementation = new AegylaxGame();
        lens = new AegylaxLens();

        bytes memory initData =
            abi.encodeCall(AegylaxGame.initialize, (owner, address(engine), defaultParams(), uint64(block.number)));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        game = AegylaxGame(payable(address(proxy)));

        vm.prank(owner);
        game.setLens(address(lens));
        // The draw cadence is its own setting rather than a `GameParams`
        // field (see `AegylaxStorage`), so the harness turns it on explicitly.
        // Small enough that a test can reach a draw epoch by rolling.
        vm.prank(owner);
        game.setGlobalDefenseInterval(DRAW_INTERVAL);
        vm.prank(owner);
        engine.setGame(address(game));

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function defaultParams() internal pure returns (GameTypes.GameParams memory p) {
        p = GameTypes.GameParams({
            gridColumns: 10,
            gridRows: 5,
            sectorSpanKm: 1000,
            interceptRadiusMilliSectors: 140,
            epochBlocks: 150,
            defenseSpeedKmPerBlock: 250,
            probeConeMicroRad: 174_533, // 10° — shutter jitter, above one intercept radius
            revealGraceBlocks: 1000,
            minPlayers: 2,
            maxPlayers: 20,
            maxProbesPerPlayer: 8,
            freeProbes: 3,
            maxCreatorFeeBps: 500,
            minRegistrationSeconds: 0,
            maxRegistrationSeconds: 30 days,
            minEntryFee: 0.001 ether,
            maxEntryFee: 0.1 ether,
            minStartPrizePool: 0.01 ether,
            probePrice: PROBE_PRICE,
            protocolJoinFee: 0.0005 ether
        });
    }

    function defaultConfig() internal view returns (GameTypes.LobbyConfig memory c) {
        c = GameTypes.LobbyConfig({
            name: "Operation Test",
            minPlayers: 2,
            maxPlayers: 10,
            entryPrice: ENTRY,
            registrationDeadline: uint64(block.timestamp + REGISTRATION),
            // The authoritative deadline, and what the attack's epoch is
            // derived from. The timestamp above is the creator's stated
            // intent; this is what the protocol closes applications on.
            registrationDeadlineBlock: uint64(block.number + REGISTRATION_BLOCKS),
            startPrizePool: POOL,
            creatorFeeBps: 500
        });
    }

    /**
     * Past the application window, in both units the config carries.
     *
     * Tests used to move only the clock, which was enough while the
     * deadline was a timestamp. It is a block now — that is what lets an
     * operation schedule its own attack — so a test that only warps leaves
     * applications open as far as the protocol is concerned.
     */
    function closeApplications() internal {
        vm.warp(block.timestamp + REGISTRATION + 1);
        vm.roll(block.number + REGISTRATION_BLOCKS + 1);
    }

    function joinCost() internal pure returns (uint256) {
        return ENTRY + (uint256(ENTRY) * 500) / 10_000;
    }

    /**
     * The bounty *and* the protocol's creation fee.
     *
     * The fee is charged once, at mint, and never comes back — even if the
     * room never fills. Launching costs the pool plus that fee.
     */
    function createCost() internal view returns (uint256) {
        return POOL + defaultParams().protocolJoinFee;
    }

    function createLobby() internal returns (bytes32 lobbyId) {
        vm.prank(creator);
        lobbyId = game.createLobby{value: createCost()}(defaultConfig());
    }

    function createLobbyWithDeadlineBlock(uint64 deadlineBlock) internal returns (bytes32 lobbyId) {
        GameTypes.LobbyConfig memory c = defaultConfig();
        c.registrationDeadlineBlock = deadlineBlock;
        vm.prank(creator);
        lobbyId = game.createLobby{value: createCost()}(c);
    }

    function join(bytes32 lobbyId, address who) internal {
        vm.prank(who);
        game.joinLobby{value: joinCost()}(lobbyId);
    }

    /**
     * Fills an operation and closes applications, leaving the attack
     * *scheduled but not yet airborne*.
     *
     * This is the preparation window: the launch lands on the next epoch
     * boundary, so there is a real stretch of blocks here in which Recon
     * Probes may still be bought (ТЗ §3). Tests about equipping for an
     * attack belong at this point; tests about fighting one belong after
     * `startedLobby`.
     */
    function scheduledLobby() internal returns (bytes32 lobbyId, bytes32 attackId) {
        lobbyId = createLobby();
        join(lobbyId, alice);
        join(lobbyId, bob);

        closeApplications();
        game.startOperation(lobbyId);

        (GameTypes.Lobby memory lobby,,) = AegylaxLens(address(game)).getLobby(lobbyId);
        attackId = lobby.attackId;
    }

    /// Fills an operation, closes applications and puts the attack in flight.
    function startedLobby() internal returns (bytes32 lobbyId, bytes32 attackId) {
        (lobbyId, attackId) = scheduledLobby();
        (GameTypes.Attack memory attack,) = AegylaxLens(address(game)).getAttack(attackId);
        vm.roll(attack.launchBlock);
    }

    function lensOf() internal view returns (AegylaxLens) {
        return AegylaxLens(address(game));
    }

    function attackOf(bytes32 attackId) internal view returns (GameTypes.Attack memory attack) {
        (attack,) = lensOf().getAttack(attackId);
    }

    /// The threat an operation is bound to — every lobby knows it from creation.
    function lobbyAttack(bytes32 lobbyId) internal view returns (bytes32) {
        (GameTypes.Lobby memory lobby,,) = lensOf().getLobby(lobbyId);
        return lobby.attackId;
    }

    /// What the mock drew — a test's stand-in for "the covalidator told me".
    function secretOf(bytes32 attackId) internal view returns (uint256 thetaRaw, uint256 deltaRaw) {
        GameTypes.Attack memory attack = attackOf(attackId);
        thetaRaw = engine.unsafePeek(attack.bearingHandle);
        deltaRaw = engine.unsafePeek(attack.deltaHandle);
    }

    function trajectoryOf(bytes32 attackId) internal view returns (GameTypes.Trajectory memory) {
        (uint256 thetaRaw, uint256 deltaRaw) = secretOf(attackId);
        GameTypes.Attack memory attack = attackOf(attackId);
        return Geometry.deriveTrajectory(world(), thetaRaw, deltaRaw, attack.flightBlocks);
    }

    function world() internal pure returns (Geometry.World memory) {
        GameTypes.GameParams memory p = defaultParams();
        return Geometry.buildWorld(p.gridColumns, p.gridRows, p.sectorSpanKm);
    }

    function submitPoint(bytes32 lobbyId, address who, int256 x, int256 y) internal {
        bytes memory ciphertext = engine.unsafeEncode(Geometry.packPoint(uint256(x), uint256(y)));
        vm.prank(who);
        game.submitDefense(lobbyId, ciphertext);
    }

    /// Advance the chain far enough that this wallet may send (or collect) again.
    function waitProbeDelay() internal {
        vm.roll(block.number + ReconRules.DELAY_BLOCKS);
    }

    function sendProbeReady(bytes32 lobbyId, address who, uint16 column, uint16 row) internal returns (bytes32 handle) {
        GameTypes.Participant memory p = lensOf().getParticipant(lobbyId, who);
        if (p.lastProbeBlock != 0) {
            uint256 readable = uint256(p.lastProbeBlock) + uint256(ReconRules.DELAY_BLOCKS);
            if (block.number < readable) vm.roll(readable);
        }
        vm.prank(who);
        handle = game.sendProbe(lobbyId, column, row);
    }

    function collectReady(bytes32 handle) internal {
        GameTypes.ProbeFlight memory flight = lensOf().getProbeFlight(handle);
        if (block.number < flight.readableAtBlock) vm.roll(flight.readableAtBlock);
        game.collectProbe(handle);
    }

    /// Fetches the plaintexts a reveal needs, exactly as a client would after unlocking.
    function proofsFor(bytes32 lobbyId, bytes32 attackId)
        internal
        view
        returns (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        )
    {
        GameTypes.Attack memory attack = attackOf(attackId);
        bytes[] memory noSignatures = new bytes[](0);

        bearing = GameTypes.DecryptionProof(engine.unsafePeek(attack.bearingHandle), noSignatures);
        delta = GameTypes.DecryptionProof(engine.unsafePeek(attack.deltaHandle), noSignatures);

        GameTypes.DefenseAttempt[] memory attempts = lensOf().getDefenseAttempts(lobbyId);
        defenses = new GameTypes.DecryptionProof[](attempts.length);
        for (uint256 i = 0; i < attempts.length; i++) {
            defenses[i] = GameTypes.DecryptionProof(engine.unsafePeek(attempts[i].pointHandle), noSignatures);
        }
    }

    /// Rolls past impact and lands the epoch's attack — the global half.
    function landAttack(bytes32 attackId) internal {
        GameTypes.Attack memory attack = attackOf(attackId);
        vm.roll(attack.impactBlock + 1);
        game.completeAttack(attack.epochId);
    }

    /// Publishes the epoch's geometry, once, for everyone.
    function revealEpoch(bytes32 lobbyId, bytes32 attackId) internal {
        (GameTypes.DecryptionProof memory bearing, GameTypes.DecryptionProof memory delta,) =
            proofsFor(lobbyId, attackId);
        game.revealEpochAttack(attackOf(attackId).epochId, bearing, delta);
    }

    /**
     * The whole ending, as a test sees it: the epoch's threat lands and is
     * published once, then this one team is scored against it.
     */
    function completeAndReveal(bytes32 lobbyId, bytes32 attackId) internal {
        GameTypes.Attack memory attack = attackOf(attackId);
        vm.roll(attack.impactBlock + 1);
        if (attack.status != GameTypes.AttackStatus.RESOLVED) {
            game.completeAttack(attack.epochId);
        }
        game.unlockDefenses(lobbyId);

        (
            GameTypes.DecryptionProof memory bearing,
            GameTypes.DecryptionProof memory delta,
            GameTypes.DecryptionProof[] memory defenses
        ) = proofsFor(lobbyId, attackId);

        if (!lensOf().isRevealed(attackId)) {
            game.revealEpochAttack(attack.epochId, bearing, delta);
        }
        game.resolveLobby(lobbyId, defenses);
    }

    /**
     * Opens the Global Defense draw once the join window has started.
     *
     * `openGlobalDefense` is refused until the last day (or half the interval,
     * when N epochs is shorter than a day) before the draw epoch. Tests that
     * play a round to feed the pool are usually still in the accumulation
     * half, so they have to roll here rather than calling the write raw.
     */
    function warpToDrawWindow() internal {
        (uint32 nextEpoch, uint32 interval,,) = lensOf().getGlobalDefenseDraw();
        uint32 epochBlocks = defaultParams().epochBlocks;
        uint64 genesis = lensOf().genesisBlock();
        uint64 latest = genesis + uint64(nextEpoch) * uint64(epochBlocks) - 1;
        uint256 intervalBlocks = uint256(interval) * uint256(epochBlocks);
        uint256 dayBlocks = 1 days / 2;
        uint256 window = intervalBlocks < dayBlocks
            ? (intervalBlocks / 2 == 0 ? 1 : intervalBlocks / 2)
            : dayBlocks;
        uint64 openFrom = latest > uint64(window) ? latest - uint64(window) : uint64(block.number);
        if (block.number < openFrom) {
            uint256 delta = uint256(openFrom) - block.number;
            vm.roll(openFrom);
            vm.warp(block.timestamp + delta * 2);
        }
    }

    function openDrawWhenDue() internal returns (bytes32 drawId, uint32 epochId) {
        warpToDrawWindow();
        return game.openGlobalDefense();
    }

    function rendezvousBlock(bytes32 attackId, uint256 progressPermille) internal view returns (uint64 submitAt) {
        (int256 x, int256 y) = pointOnTrajectory(attackId, progressPermille);
        GameTypes.Attack memory attack = attackOf(attackId);
        GameTypes.GameParams memory p = defaultParams();
        Geometry.World memory w = Geometry.buildWorld(p.gridColumns, p.gridRows, p.sectorSpanKm);
        uint256 climbScaled = Geometry.arrivalBlockScaled(w, Geometry.Point(x, y), 0, p.defenseSpeedKmPerBlock);
        uint256 passScaled = uint256(attack.launchBlock) * GameTypes.TIME_SCALE
            + (uint256(attack.flightBlocks) * progressPermille * GameTypes.TIME_SCALE) / 1000;
        uint256 submitScaled =
            passScaled > climbScaled ? passScaled - climbScaled : uint256(attack.launchBlock) * GameTypes.TIME_SCALE;
        submitAt = uint64(submitScaled / GameTypes.TIME_SCALE);
        if (submitAt < attack.launchBlock) submitAt = attack.launchBlock;
        if (submitAt >= attack.impactBlock) submitAt = attack.impactBlock - 1;
    }

    /**
     * Submit so climb lands when the threat is at this progress — the
     * snapshot the protocol actually scores.
     */
    function timedSubmitOnTrajectory(bytes32 lobbyId, bytes32 attackId, address who, uint256 progressPermille)
        internal
    {
        (int256 x, int256 y) = pointOnTrajectory(attackId, progressPermille);
        vm.roll(rendezvousBlock(attackId, progressPermille));
        submitPoint(lobbyId, who, x, y);
    }

    /**
     * A point that is certain to intercept: `progress` of the way along the
     * true trajectory. Tests that are about ranking or claims should not
     * also be about whether a guess happened to land.
     */
    function pointOnTrajectory(bytes32 attackId, uint256 progressPermille)
        internal
        view
        returns (int256 x, int256 y)
    {
        GameTypes.Trajectory memory traj = trajectoryOf(attackId);
        x = traj.startX + ((traj.targetX - traj.startX) * int256(progressPermille)) / 1000;
        y = traj.startY + ((traj.targetY - traj.startY) * int256(progressPermille)) / 1000;
    }
}
