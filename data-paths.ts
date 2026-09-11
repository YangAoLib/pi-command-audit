import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const extensionRoot = dirname(fileURLToPath(import.meta.url));
export const dataRoot = join(extensionRoot, "data");
export const compatibilityDataRoot = join(dataRoot, "compat");
