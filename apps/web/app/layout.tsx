import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@tensquads/ui/fonts.css";
import "@tensquads/ui/tokens.css";
import "@tensquads/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
	title: "tensquads: talk to Petra",
	description: "The owner page of tensquads. Talk to Petra, follow your tasks, and approve actions.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
