import assert from "node:assert/strict";
import test from "node:test";

import { regularText, searchQuery } from "../src/index.js";

test("M12: the regular text has one form of alef, no diacritics, no tatweel and no capital letters", () => {
	assert.equal(regularText("أحمد إبراهيم آمنة ٱلبيت"), "احمد ابراهيم امنة البيت");
	assert.equal(regularText("مُحَمَّدٌ"), "محمد");
	assert.equal(regularText("القهـــوة"), "القهوة");
	assert.equal(regularText("The Shop OPENS"), "the shop opens");
});

test("M12: the search query has each word of the regular text one time, joined with or", () => {
	assert.equal(searchQuery("When does the shop open? The shop!"), "when | does | the | shop | open");
	assert.equal(searchQuery("أَحْمَد يدفع"), "احمد | يدفع");
	assert.equal(searchQuery("?! ..."), "");
});
