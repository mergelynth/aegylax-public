// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {GameTypes} from "./GameTypes.sol";
import {Geometry} from "./Geometry.sol";

/**
 * Where a configuration is judged legal.
 *
 * Both checks run at the only moment they can be enforced — inside the
 * transaction that would otherwise take effect — so a hand-edited payload,
 * a modified frontend bundle or a direct contract call all land here. The
 * frontend re-implements the same ranges to grey out a button; this is the
 * copy that decides.
 *
 * It is an external library so the game implementation stays under the EVM
 * code size limit. That has a second benefit worth naming: the rules can be
 * read, diffed and audited on their own, apart from the state machine that
 * applies them.
 */
library ProtocolRules {
    error InvalidConfig(string field);
    error InvalidParams(string field);

    /// The protocol's own boundaries. Nothing here is creator-settable.
    function validateParams(GameTypes.GameParams memory p) public pure {
        if (p.gridColumns == 0 || p.gridRows == 0) revert InvalidParams("grid");
        if (p.sectorSpanKm == 0) revert InvalidParams("sectorSpanKm");
        if (p.epochBlocks == 0) revert InvalidParams("epochBlocks");
        if (p.interceptRadiusMilliSectors == 0) revert InvalidParams("interceptRadius");
        if (p.defenseSpeedKmPerBlock == 0) revert InvalidParams("defenseSpeed");
        if (p.probeConeMicroRad == 0) revert InvalidParams("probeCone");
        if (p.minPlayers < 2) revert InvalidParams("minPlayers");
        if (p.maxPlayers < p.minPlayers) revert InvalidParams("maxPlayers");
        if (p.maxProbesPerPlayer == 0) revert InvalidParams("maxProbesPerPlayer");
        // Free probes are drawn from the same allowance, so an allowance
        // smaller than the free grant would hand out probes nobody may send.
        if (p.freeProbes > p.maxProbesPerPlayer) revert InvalidParams("freeProbes");
        if (p.maxCreatorFeeBps > GameTypes.BPS) revert InvalidParams("maxCreatorFeeBps");
        if (p.maxEntryFee < p.minEntryFee) revert InvalidParams("entryFeeRange");
        if (p.maxRegistrationSeconds < p.minRegistrationSeconds) revert InvalidParams("registrationRange");
        if (p.revealGraceBlocks == 0) revert InvalidParams("revealGraceBlocks");
        // A board too shallow for its globe would let a trajectory clip
        // Earth on its way to the target. Checked once, here, rather than
        // hoped for on every attack.
        if (!Geometry.boardSupportsAttacks(p.gridRows, p.sectorSpanKm)) revert InvalidParams("gridRows");
    }

    /**
     * The creator's half of an operation's terms, checked against the
     * protocol's.
     *
     * The deadline is checked twice because it is two things. The timestamp
     * is what the creator chose and is what the protocol's window limits are
     * expressed in; the block is what applications actually close on, and
     * what the attack's epoch is derived from. Both have to be in the
     * future, and neither can be inferred from the other — a contract cannot
     * convert seconds to blocks without assuming a block time, which is
     * exactly the assumption the protocol refuses to make (ТЗ §20).
     */
    function validateConfig(
        GameTypes.LobbyConfig memory c,
        GameTypes.GameParams memory p,
        uint256 nowTimestamp,
        uint256 nowBlock
    ) public pure {
        if (bytes(c.name).length == 0 || bytes(c.name).length > 48) revert InvalidConfig("name");
        if (c.minPlayers < p.minPlayers) revert InvalidConfig("minPlayers");
        if (c.maxPlayers > p.maxPlayers || c.maxPlayers < c.minPlayers) revert InvalidConfig("maxPlayers");
        if (c.entryPrice < p.minEntryFee || c.entryPrice > p.maxEntryFee) revert InvalidConfig("entryPrice");
        if (c.startPrizePool < p.minStartPrizePool) revert InvalidConfig("startPrizePool");
        if (c.creatorFeeBps > p.maxCreatorFeeBps) revert InvalidConfig("creatorFeeBps");
        if (c.registrationDeadline <= nowTimestamp) revert InvalidConfig("deadline");
        if (c.registrationDeadlineBlock <= nowBlock) revert InvalidConfig("deadlineBlock");

        uint256 window = uint256(c.registrationDeadline) - nowTimestamp;
        if (window < p.minRegistrationSeconds || window > p.maxRegistrationSeconds) {
            revert InvalidConfig("registrationWindow");
        }
    }
}
