import React from "react";
import { LoaderCircle } from "lucide-react";

export function ThreadRunningIcon() {
  return <LoaderCircle className="spin" size={12} aria-hidden="true" />;
}
