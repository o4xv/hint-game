import { useState } from "react";
import { useGame, useSession } from "./GameContext";
import { Dialog } from "./Dialog";

export function LeaveButton() {
  const { leave } = useGame();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label="مغادرة الغرفة"
        onClick={() => {
          setOpen(true);
        }}
      >
        →
      </button>
      {open && (
        <Dialog
          title="مغادرة الغرفة؟"
          onClose={() => {
            setOpen(false);
          }}
        >
          <p>هل تريد مغادرة المباراة؟</p>
          <button className="btn btn-primary" type="button" onClick={leave}>
            مغادرة
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            إلغاء
          </button>
        </Dialog>
      )}
    </>
  );
}

export function JoinRequests() {
  const { controller } = useGame();
  const state = useSession((state) => state);
  const request = state.pendingJoinRequests[0];
  if (!state.isOwner || !request || !state.roomCode) return null;
  const roomCode = state.roomCode;
  const reject = () => {
    controller.send("reject_join_request", { roomCode, requestId: request.requestId });
  };
  return (
    <Dialog key={request.requestId} title="طلب انضمام جديد" onClose={reject}>
      <p>يريد {request.displayName} الانضمام إلى الغرفة.</p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          controller.send("approve_join_request", { roomCode, requestId: request.requestId });
        }}
      >
        قبول
      </button>
      <button type="button" className="btn btn-secondary" onClick={reject}>
        رفض
      </button>
    </Dialog>
  );
}

/** Room management body, shared by the lobby dialog and the in-game menu panel. */
export function RoomControlPanel({ onDone }: { onDone?: () => void } = {}) {
  const { controller } = useGame();
  const state = useSession((state) => state);
  const [confirmation, setConfirmation] = useState<{
    event: "kick_player" | "transfer_ownership";
    playerId: string;
    name: string;
  } | null>(null);
  if (!state.isOwner || !state.roomCode) return null;
  const roomCode = state.roomCode;
  return (
    <>
      {confirmation ? (
        <>
          <p>
            {confirmation.event === "kick_player"
              ? `إزالة ${confirmation.name}؟ لن يتمكن من العودة بهذه الجلسة.`
              : `تسليم إدارة الغرفة؟ سيصبح ${confirmation.name} صاحب الغرفة الجديد.`}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              controller.send(confirmation.event, {
                roomCode,
                playerId: confirmation.playerId,
              });
              setConfirmation(null);
              onDone?.();
            }}
          >
            {confirmation.event === "kick_player" ? "إزالة" : "تسليم الإدارة"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setConfirmation(null);
            }}
          >
            إلغاء
          </button>
        </>
      ) : (
        <>
          <p className="room-code-inline">
            رمز الغرفة: <bdi>{roomCode}</bdi>
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={state.roomLocked}
            onClick={() => {
              controller.send("set_room_lock", { roomCode, locked: !state.roomLocked });
            }}
          >
            {state.roomLocked ? "فتح الغرفة للانضمام" : "قفل الغرفة أمام الطلبات"}
          </button>
          <h3 className="room-controls-section-title">اللاعبون</h3>
          {state.players.map((player) => (
            <div key={player.id} className="room-control-row">
              <div>
                <strong>{player.displayName}</strong>
                {player.awaitingNextRound ? (
                  <small>سينضم في الجولة التالية</small>
                ) : (
                  !player.isConnected && <small>غير متصل</small>
                )}
              </div>
              {player.id !== state.playerId && (
                <div className="room-control-actions">
                  {player.isConnected && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setConfirmation({
                          event: "transfer_ownership",
                          playerId: player.id,
                          name: player.displayName,
                        });
                      }}
                    >
                      تسليم الإدارة
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary room-control-danger"
                    onClick={() => {
                      setConfirmation({
                        event: "kick_player",
                        playerId: player.id,
                        name: player.displayName,
                      });
                    }}
                  >
                    إزالة
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

export function RoomControls({ inline = false }: { inline?: boolean }) {
  const state = useSession((state) => state);
  const [open, setOpen] = useState(false);
  if (!state.isOwner || !state.roomCode) return null;
  return (
    <>
      <button
        className={inline ? "btn btn-secondary room-controls-inline" : "room-controls-button"}
        type="button"
        aria-label="إدارة الغرفة"
        onClick={() => {
          setOpen(true);
        }}
      >
        {inline ? "إدارة الغرفة" : "⚙"}
      </button>
      {open && (
        <Dialog
          title="إدارة الغرفة"
          onClose={() => {
            setOpen(false);
          }}
        >
          <RoomControlPanel
            onDone={() => {
              setOpen(false);
            }}
          />
        </Dialog>
      )}
    </>
  );
}
