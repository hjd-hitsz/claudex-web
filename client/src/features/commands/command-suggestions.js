import {
  FileCode,
  Folder,
  Sparkles,
  SquarePen,
  Brain,
  ListChecks,
  GitPullRequest,
  Minimize2,
  TerminalSquare,
  Search,
  Settings,
  GitBranch,
  Square,
  Pencil,
  Trash2,
} from "lucide-react";
import { composerCommands } from "./composer-commands.js";

const icons = {
  init: FileCode,
  new: SquarePen,
  model: Brain,
  plan: ListChecks,
  goal: ListChecks,
  review: GitPullRequest,
  compact: Minimize2,
  skills: Sparkles,
  files: Folder,
  diff: GitBranch,
  terminal: TerminalSquare,
  project: Folder,
  search: Search,
  status: Settings,
  fork: GitBranch,
  rename: Pencil,
  delete: Trash2,
  stop: Square,
};
export const commandSuggestions = composerCommands.map((command) => ({
  ...command,
  icon: icons[command.id] || Settings,
}));
