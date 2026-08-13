import demoTranscript from "../public/demo-transcript.json";
import { AnswerViewer, type DemoTranscript } from "./AnswerViewer";

export default function Home() {
  return <AnswerViewer initialTranscript={demoTranscript as unknown as DemoTranscript} />;
}
