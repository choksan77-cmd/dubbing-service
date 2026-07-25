import { Suspense } from "react";
import DubStudio from "./DubStudio";

export default function DubPage() {
  return (
    <Suspense fallback={null}>
      <DubStudio />
    </Suspense>
  );
}
