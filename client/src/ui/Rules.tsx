import { useState } from "react";
import { Dialog } from "./Dialog";
import { HelpPanel } from "./Tutorial";
import { useSession } from "./GameContext";

const sections = [
  { title: "الهدف", text: "خمّن موقع الهدف السري على المقياس اعتماداً على تلميح واحد من الوسيط." },
  {
    title: "مثال",
    text: "إذا كانت البطاقة «بارد ↔ حار» والهدف قريباً من جهة الحار، قد يقول الوسيط: «شاي دافئ».",
  },
  {
    title: "طريقة اللعب",
    text: "يرى الوسيط الهدف وحده، ثم يكتب تلميحاً. يضع اللاعبون مؤشراتهم حيث يناسب التلميح، وبعدها يظهر الهدف وتحسب النقاط.",
  },
  {
    title: "نقاط التخمين",
    text: "المنطقة الوسطى تساوي 3 نقاط، ثم نقطتين، ثم نقطة واحدة. خارج المناطق يساوي 0.",
  },
  {
    title: "نقاط الوسيط",
    text: "في وضع «كل لاعب»، يحصل الوسيط على متوسط نقاط التخمين بعد التقريب. تضاف نقطة لإصابة اللاعب الوحيد للمنتصف، أو نقطة لكل إصابة دقيقة بحد أقصى نقطتين. إذا أخفق لاعبان أو أكثر تماماً تُخصم نقطة. في وضع الفرق تضاف نقاط التخمين إلى مجموع الفريق فقط، ولا توجد نقاط منفصلة للوسيط.",
  },
  {
    title: "تغيير البطاقة أو تخطي الدور",
    text: "قبل إرسال التلميح يمكن للوسيط تغيير البطاقة مرة واحدة في الدور دون خصم نقاط، ويبقى الوسيط والفريق والمؤقت والهدف كما هي. أما تخطي الدور فينهي الدور: تُخصم نقطة من الوسيط في وضع «كل لاعب» أو من الفريق النشط في وضع الفرق، ثم ينتقل الدور إلى الوسيط التالي.",
  },
  {
    title: "الفوز",
    text: "يفوز كل لاعب أو فريق يحقق أعلى نتيجة عند بلوغ هدف المباراة؛ لذلك يمكن أن تنتهي المباراة بتعادل مشترك.",
  },
];

export function Rules({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const gameMode = useSession((state) => state.gameMode);
  function close() {
    setOpen(false);
    try {
      localStorage.setItem("hint_intro_seen", "1");
    } catch {
      /* Optional guidance history. */
    }
  }
  return (
    <>
      <button
        className={compact ? "icon-button" : "btn btn-ghost lobby-help-button"}
        type="button"
        aria-label="شرح اللعبة"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        {compact ? "?" : "شرح اللعبة"}
      </button>
      {open && (
        <Dialog
          title="كيف تلعب هنت؟"
          closeLabel="إغلاق شرح اللعبة"
          onClose={close}
          className="help-dialog"
        >
          <HelpPanel initialMode={gameMode} />
        </Dialog>
      )}
    </>
  );
}

/** The rules body, shared by the lobby dialog and the in-game menu panel. */
export function RulesContent() {
  return (
    <>
      {sections.map((section) => (
        <section key={section.title} className="rules-dialog-section">
          <h3>{section.title}</h3>
          <p>{section.text}</p>
        </section>
      ))}
    </>
  );
}
