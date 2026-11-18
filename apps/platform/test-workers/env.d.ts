// The type of the main module, so that the tests get the types of exports.default.
import type * as main from "../src/index.js";

declare global {
	namespace Cloudflare {
		interface GlobalProps {
			mainModule: typeof main;
		}
	}
}
