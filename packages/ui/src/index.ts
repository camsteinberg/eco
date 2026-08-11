// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Core components
export { Button } from "./components/Button.js";
export { Input } from "./components/Input.js";
export { Card } from "./components/Card.js";
export { Badge } from "./components/Badge.js";
export { Toggle } from "./components/Toggle.js";
export { Toast, ToastProvider, useToast } from "./components/Toast.js";
export type { ToastType, ToastItem } from "./components/Toast.js";
export { Tooltip } from "./components/Tooltip.js";
export { Modal } from "./components/Modal.js";

// Chat components
export { ChatInput } from "./ChatInput.js";
export type { ChatInputProps } from "./ChatInput.js";
export { ChatMessage } from "./ChatMessage.js";
export type { ChatMessageProps } from "./ChatMessage.js";
export { ChatWindow } from "./ChatWindow.js";
export type { ChatWindowProps, ChatWindowMessage } from "./ChatWindow.js";

// Tokens
export { colors } from "./tokens/colors.js";
export type { Theme } from "./tokens/colors.js";

// Animations
export { springPresets, getTransition } from "./animations/presets.js";

// Illustrations
export {
  SeedIllustration,
  SproutIllustration,
  SaplingIllustration,
  TreeIllustration,
  LeafDivider,
  ForestClearing,
  WiltedPlant,
  VineBorder,
  WateringCan,
  SunThroughCanopy,
  FernIllustration,
  SeedlingIllustration,
  PineIllustration,
  LeafIllustration,
  WiltedPlantIllustration,
} from "./illustrations/index.js";

// Patterns
export { EmptyState } from "./patterns/EmptyState.js";
export {
  FeedbackToast,
  useFeedbackToast,
} from "./patterns/FeedbackToast.js";
