// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * AEGYLAX on-chain data model.
 *
 * Every value the protocol judges an operation by lives here, and nothing
 * here is derived from the frontend: the parameters an operation is played
 * under are snapshotted onto the lobby when it is created, so a later
 * protocol-parameter change (or a contract upgrade) can never move the
 * goalposts under a running operation (ТЗ §8).
 *
 * Units, fixed once for the whole protocol:
 *   - money       — wei;
 *   - distance    — "world units" (wu), 1 km = 1e6 wu;
 *   - angle       — microradians (1e-6 rad);
 *   - block time  — block numbers; interception times are block numbers
 *                   scaled by 1e6 so a sub-block ordering is expressible.
 */
library GameTypes {
    /// wu per km. All coordinates and distances are in wu.
    int256 internal constant WU = 1e6;
    /// Fixed-point scale used for sub-block timing.
    uint256 internal constant TIME_SCALE = 1e6;
    uint256 internal constant BPS = 10_000;

    enum LobbyStatus {
        NONE,
        OPEN,
        READY,
        ACTIVE,
        RESOLVED,
        CANCELLED
    }

    enum AttackStatus {
        NONE,
        PENDING,
        LAUNCHED,
        COMPLETED,
        RESOLVED
    }

    /**
     * How an operation ended — which is a different question from what state
     * it is in, and the two were being answered by one field.
     *
     * `LobbyStatus` is a state machine: it says whether money may still move
     * and which transitions are legal. It has exactly two terminal values and
     * they were carrying three genuinely different endings between them, with
     * the result that "nobody could be bothered to play" and "the protocol
     * failed to run the round" were the same word on screen and, worse, the
     * same rule in `Settlement`.
     *
     * COMPLETED — the round *happened*. At least one defender took a real
     *   action, the attack flew and landed, and the operation was scored.
     *   Zero interceptions is a perfectly ordinary COMPLETED: the threat won.
     *   Nothing is refunded, because nothing was left undelivered — and the
     *   pool, having no winner to go to, goes to the Global Defense Pool
     *   rather than back to the creator. That last part is the change with
     *   teeth: a bounty that comes home on a miss is a bounty that costs its
     *   creator nothing to advertise.
     *
     * UNPLAYED — nobody actually played. No valid action from any
     *   participant, or not enough of them turned up to start at all. The
     *   operation died without an event, so every wei paid into it goes back:
     *   entries, author commissions and probes alike. Nothing was consumed
     *   because nothing happened. The protocol creation fee stays.
     *
     * CANCELLED — the protocol failed the round. The attack could not be
     *   completed or published, the grace window ran out, and the players are
     *   owed their money for a game that was never correctly run. Same refund
     *   as UNPLAYED, and deliberately a distinct name: one of these is the
     *   players' doing and the other is ours, and an operation's record should
     *   not blur that.
     */
    enum Ending {
        NONE,
        COMPLETED,
        UNPLAYED,
        CANCELLED
    }

    /**
     * Protocol-owned rules. Creators pick lobby values *inside* these; they
     * never set one. Stored in contract storage (not constants) so a
     * protocol change is a governed transaction with an event, and copied
     * onto every lobby at creation so a running operation is immutable.
     */
    struct GameParams {
        uint16 gridColumns;
        uint16 gridRows;
        /// Side of one sector, in km — the playfield's only declared scale.
        uint32 sectorSpanKm;
        /// DEFENSE_INTERCEPTION_RADIUS in thousandths of a sector (140 = 0.14).
        uint32 interceptRadiusMilliSectors;
        /// Blocks per epoch. An attack launches on one boundary and impacts on the next,
        /// so this is also the full flight time T_attack (ТЗ §4).
        uint32 epochBlocks;
        /// How fast an interceptor climbs to its Defense Point, km per block (ТЗ §5).
        uint32 defenseSpeedKmPerBlock;
        /**
         * Angular jitter half-width, in microradians, added independently to
         * the noisy launch bearing θ and impact offset δ a probe returns.
         *
         * The encrypted answer is `δ_noisy << 32 | θ_noisy`. The field keeps
         * this name and this slot so a governed `setParams` retunes the
         * shutter without a storage-layout change. Sized above one intercept
         * radius so sitting Defense on a mark is not a free hit.
         */
        uint32 probeConeMicroRad;
        /// Blocks after impact before an attack nobody revealed can be expired and refunded.
        uint32 revealGraceBlocks;
        uint16 minPlayers;
        uint16 maxPlayers;
        /**
         * Recon Probes per player, per attack — protocol-owned.
         *
         * The attack is one global event, so what a probe buys is knowledge
         * about a threat every operation of the epoch is facing. A creator
         * who could set this would be setting how much the *world* may know,
         * and the cheapest operation on the epoch would decide it for
         * everybody. The allowance resets with each attack.
         */
        uint16 maxProbesPerPlayer;
        /// Recon Probes every player starts an attack with, protocol-owned.
        uint16 freeProbes;
        uint16 maxCreatorFeeBps;
        uint32 minRegistrationSeconds;
        uint32 maxRegistrationSeconds;
        uint128 minEntryFee;
        uint128 maxEntryFee;
        uint128 minStartPrizePool;
        /**
         * What one Recon Probe costs — a price, not a ceiling.
         *
         * Creator-set probe prices cannot survive a global attack: probing
         * in the cheapest operation on the epoch yields knowledge that
         * applies to every other one, so recon would simply be bought where
         * it is cheapest and spent where the pool is richest. One price for
         * the epoch's one threat is what closes that arbitrage.
         */
        uint128 probePrice;
        /// Flat protocol fee charged to the creator when they mint an operation.
        /// Never refunded — the treasury's from the moment of creation.
        uint128 protocolJoinFee;
    }
    /*
     * The Global Defense draw interval is deliberately **not** in this struct,
     * and the reason is worth recording because the obvious place for it is
     * right here.
     *
     * Two things are wrong with putting it in `GameParams`. The first is
     * structural: this struct is snapshotted onto every lobby and every epoch,
     * so a field here is a rule an *operation is played under* — and the draw
     * cadence is not. It is a protocol-wide schedule; no operation needs a
     * frozen copy of when the next draw happens, and giving each one a copy
     * would let two operations disagree about it.
     *
     * The second is fatal. `GameStorage.params` holds a `GameParams` **inline**,
     * not behind a mapping, and these twenty fields pack into exactly four
     * slots with no spare bytes in the last one. Appending anything grows the
     * struct to five slots and shifts every field after it — `paramsVersion`,
     * `genesisBlock`, `protocolTreasury`, every counter, and the base slot of
     * every mapping in the layout. On an upgrade that is not a migration, it
     * is silent, total state corruption: existing lobbies read as empty and
     * the treasury reads somebody else's number. It lives on `GameStorage`
     * instead, appended at the end of the namespace where nothing can move.
     */

    /**
     * The creator-chosen half of an operation's terms.
     *
     * What a creator sets is who may join, what a seat costs and what the
     * pool is worth — the terms of *their* team. Recon is deliberately not
     * on that list any more: the threat belongs to the epoch rather than to
     * any one operation, so what a probe reveals is worth the same in every
     * lobby, and letting each creator price it would only decide where
     * everybody buys it.
     */
    struct LobbyConfig {
        string name;
        uint16 minPlayers;
        uint16 maxPlayers;
        uint128 entryPrice;
        /**
         * Unix seconds — the wall-clock time the creator picked, kept for
         * display and for the protocol's own window limits.
         *
         * It is deliberately *not* what the protocol closes applications on.
         * A timestamp cannot be turned into an epoch, and the epoch is the
         * thing an attack has to be scheduled against.
         */
        uint64 registrationDeadline;
        /**
         * The block applications close at — the authoritative deadline, and
         * the whole reason an operation needs nobody to start it.
         *
         * Because it is a block, `createLobby` can compute which epoch the
         * threat will fly in and mint that epoch's attack on the spot. The
         * attack is then a fact from the moment the operation exists: it
         * launches on its epoch boundary and lands on the next whether or
         * not anybody sends another transaction, and every client counts
         * down to the same block.
         */
        uint64 registrationDeadlineBlock;
        uint128 startPrizePool;
        uint16 creatorFeeBps;
    }

    struct Lobby {
        bytes32 id;
        address creator;
        uint64 createdAtBlock;
        uint64 createdAtTimestamp;
        LobbyStatus status;
        uint32 paramsVersion;
        uint16 participantCount;
        uint64 startedAtBlock;
        /// The epoch this team is defending, and so which attack it faces.
        uint32 epochId;
        bytes32 attackId;
        /// Interception attempts this team submitted — its own, not the epoch's.
        uint32 attemptCount;
        // ---- money (wei) ----
        uint128 entryFeesCollected;
        uint128 probeFeesCollected;
        /// Author commissions collected at join. Paid to the creator on a
        /// completed round; refunded to joiners if the operation never starts.
        uint128 creatorFeeAccrued;
        /// The creation fee booked on this operation. Credited to
        /// `protocolTreasury` at mint and never released, even if the room
        /// never fills.
        uint128 protocolFeeAccrued;
        /// What winners share: the creator's Start Prize Pool plus probe purchases.
        uint128 rewardPool;
        uint128 rewardsClaimed;
        bool creatorSettled;
        /**
         * How the operation ended. `NONE` while it is still running.
         *
         * Appended at the end of the struct on purpose: it packs into the
         * partially-used slot `creatorSettled` already occupies, so an
         * upgrade adds it without relocating a single existing field.
         */
        Ending ending;
        /**
         * Actions this operation's defenders actually took — probes sent and
         * defenses submitted.
         *
         * The one fact that separates a round that was *played and lost* from
         * a room that never woke up, and it has to be counted rather than
         * inferred. `attemptCount` cannot stand in for it: a team that spent
         * every probe reading the sky and then ran out of time submitted no
         * defense and unquestionably played. Nor can the money: probes can be
         * bought and never sent.
         */
        uint32 validActions;
    }

    struct Participant {
        bool joined;
        uint64 joinedAtBlock;
        uint16 probesUsed;
        uint16 probesPurchased;
        /// 1-based index into the attack's attempt list; 0 means "no defense submitted".
        uint32 defenseIndex;
        bool claimed;
        bool refunded;
        /// Everything this address paid into the operation — entry, the
        /// author's commission, and every Recon Probe. The refund basis.
        uint128 paidIn;
        /**
         * Of `paidIn`, the part spent on Recon Probes.
         *
         * Tracked in wei rather than recomputed from a count and a price,
         * because the price is protocol-owned now and may be governed
         * between a purchase and a refund — and because the two halves part
         * company at the end: an operation nobody intercepted gives entry
         * fees back and keeps what was spent on intelligence, which was
         * spent whatever the outcome.
         */
        uint128 probesPaid;
        /// Block this participant last sent a probe. 0 if they never have.
        /// A second send before `lastProbeBlock + ReconRules.DELAY_BLOCKS` reverts.
        uint64 lastProbeBlock;
    }

    /**
     * One probe's flight: computed, not yet readable.
     *
     * The hint exists as a handle from `sendProbe`. `collectProbe` is what
     * grants the owner the right to decrypt it, and only after `readableAtBlock`.
     */
    struct ProbeFlight {
        address player;
        uint64 sentBlock;
        uint64 readableAtBlock;
        bool granted;
    }

    /**
     * The epoch's one attack — the protocol's, not any operation's.
     *
     * There is no `lobbyId` here on purpose. A single threat crosses the
     * playfield each epoch and every operation running in that epoch is a
     * team computing an interception for the *same* object; which teams
     * happen to be watching is not a property of the attack. That is also
     * what makes the reveal one transaction for the world rather than one
     * per operation.
     */
    struct Attack {
        bytes32 id;
        uint32 epochId;
        uint64 launchBlock;
        uint64 impactBlock;
        uint32 flightBlocks;
        AttackStatus status;
        /// Confidential handles held by the engine — opaque here, by design (ТЗ §3).
        bytes32 bearingHandle;
        bytes32 deltaHandle;
        bool decryptionUnlocked;
        /// Whether any team on this epoch stopped it — what the planet cares about.
        bool intercepted;
    }

    /// The geometry the protocol held back, published by the first Reveal (ТЗ §3).
    struct Trajectory {
        int256 startX;
        int256 startY;
        int256 targetX;
        int256 targetY;
        int256 impactAngleMicroRad;
        int256 launchBearingMicroRad;
        /// distance(P_start, P_target) in wu.
        uint256 lengthWu;
        /// lengthWu / T_attack — derived so impact always lands on the epoch boundary (ТЗ §4).
        uint256 speedWuPerBlock;
    }

    struct DefenseAttempt {
        address participant;
        bytes32 pointHandle;
        uint64 submittedAtBlock;
        uint64 submittedAtTimestamp;
        // ---- filled in by the reveal ----
        bool revealed;
        int256 x;
        int256 y;
        /// Block (×1e6) the interceptor actually reaches the Defense Point (ТЗ §5).
        uint256 arrivalBlockScaled;
        bool intercepted;
        /// Block (×1e6) the threat first enters this point's radius. 0 when it never does.
        uint256 interceptionBlockScaled;
        int256 interceptX;
        int256 interceptY;
        uint256 missDistanceWu;
        bool isWinner;
    }

    struct Outcome {
        bool intercepted;
        int256 interceptX;
        int256 interceptY;
        uint256 interceptionBlockScaled;
        /// Winning defense's arrival time — the ranking key among snapshot hits.
        uint256 winningArrivalBlockScaled;
        uint256 interceptRadiusWu;
        address[] winners;
        uint256 rewardPerWinner;
        uint64 resolvedAtBlock;
        uint64 resolvedAtTimestamp;
        address revealedBy;
    }

    /// A covalidator-attested decryption of one confidential handle.
    struct DecryptionProof {
        uint256 value;
        bytes[] signatures;
    }
}
