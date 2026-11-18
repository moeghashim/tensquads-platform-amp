// The Platform Worker. Task 00 gives an empty Worker. Task 03 adds the interface of
// docs/ARCHITECTURE.md, section 6.5.
export default {
	fetch(): Response {
		return Response.json({ code: "not_found", message: "This call does not exist." }, { status: 404 });
	},
} satisfies ExportedHandler;
