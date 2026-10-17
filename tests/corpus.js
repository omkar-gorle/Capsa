/* Diverse hand-written chats (not the one the engine was tuned on): research, debugging, planning, tutoring,
   Hinglish, Spanish, typo-heavy, an agent that ran out of tokens mid-sentence. Each has expectations about the KEY NOTES.
   Run: node tests/corpus.js   (also run by tests/run.js) */
"use strict";
const U = require("../lib/understand.js");
const mk = (rows) => rows.map((x, i) => ({ role: x[0], text: x[1], i, confidence: 1, attachments: [] }));
const gen = (rows, o) => U.generate(U.understand(mk(rows)), Object.assign({ budget: 3000, level: 1 }, o || {})).text;

const CASES = [
  { name: "research essay (no code)", rows: [
      ["User", "I'm writing an essay on the causes of the 2008 financial crisis for my economics class. It must be under 1500 words and use APA citations."],
      ["Assistant", "Great topic. I'll outline it first.\n\nI drafted an outline with five sections: housing bubble, subprime lending, securitization, regulatory failure and contagion. I also found three sources: Lewis (2010), Gorton (2010) and the FCIC report."],
      ["User", "Good. Don't use Wikipedia as a source. Now write the housing bubble section."],
      ["Assistant", "I wrote the housing bubble section (412 words) using Lewis (2010) and the FCIC report. I'm now drafting the subprime lending section, then I'll check the word count against the 1500 limit."]],
    expect: [[/Where it stopped:.*was in the middle of — drafting the subprime lending section/, "stopped mid-draft"], [/DON'T: .*Wikipedia/, "keeps the no-Wikipedia rule"], [/APA citations|1500 words/, "keeps the hard requirements"], [/Do first: Finish what was in progress.*subprime/, "next step is the interrupted section"]] },
  { name: "debugging with a failed fix", rows: [
      ["User", "My Flask app returns a 500 error when I POST to /login. Traceback says KeyError: 'username'."],
      ["Assistant", "The form field is named user_name in the template but the view reads request.form['username']. I changed the view to use request.form.get('user_name') in app.py."],
      ["User", "Still the same error after your change."],
      ["Assistant", "Sorry. The real cause is that the form uses enctype multipart without a file input, so request.form is empty. I fixed the template in login.html and the login now returns 200."],
      ["User", "Perfect, it works now. Next add rate limiting to /login."]],
    expect: [[/rate limiting/i, "latest ask is present"], [/Do first: My last message \(#5\) never got an answer.*rate limiting/, "unanswered last message is first"], [/Still the same error|same error/, "the failed first attempt is recorded"]] },
  { name: "trip planning with decisions", rows: [
      ["User", "Plan a 5 day trip to Japan in April. Budget is 2000 USD total. We must avoid crowded tourist traps."],
      ["Assistant", "I'll suggest Tokyo, Kyoto and Nara. Let's go with Tokyo for 2 days, Kyoto for 2 days and Nara as a day trip."],
      ["User", "Yes. Actually skip Nara, use Osaka instead."],
      ["Assistant", "Done. The plan now has Tokyo 2 days, Kyoto 2 days and Osaka 1 day, and the estimated cost is 1850 USD."]],
    expect: [[/Osaka/, "mentions the replacement"], [/SUPERSEDED.*Nara|REJECTED.*Nara/i, "Nara is marked replaced"], [/2000 USD|crowded/i, "keeps budget / avoid-crowds constraints"]] },
  { name: "maths tutoring", rows: [
      ["User", "Can you teach me how to solve quadratic equations? I'm a beginner so keep it simple."],
      ["Assistant", "Sure. A quadratic equation looks like ax^2 + bx + c = 0. We can solve it by factoring, completing the square, or the quadratic formula. Let's start with factoring."],
      ["User", "ok. Now give me 3 practice problems."],
      ["Assistant", "Here are three practice problems: 1) x^2 - 5x + 6 = 0, 2) x^2 + 2x - 8 = 0, 3) 2x^2 - 3x - 2 = 0. Try them and tell me your answers."]],
    expect: [[/beginner|simple/i, "keeps the beginner preference"], [/practice problems/i, "records the practice problems"]] },
  { name: "Hinglish project", rows: [
      ["User", "Mujhe ek todo app banana hai React me. Database mat use karna, sirf localStorage chahiye."],
      ["Assistant", "Theek hai. Maine todo app bana diya hai React me, localStorage ke saath. Ab main delete button add kar raha hoon."],
      ["User", "delete button kaam nahi kar raha abhi bhi"]],
    expect: [[/Language: mixed Hindi\/English/, "flags the language honestly"], [/mat use karna|Database mat/i, "keeps the prohibition"], [/delete button/, "keeps the latest complaint"], [/Do first: My last message \(#3\)/, "unanswered last message first"]] },
  { name: "Spanish (not supported)", rows: [
      ["User", "Necesito una aplicación que calcule el presupuesto mensual de mi familia y muestre gráficos de gastos por categoría."],
      ["Assistant", "Perfecto. Creé la estructura del proyecto con una hoja de cálculo y un panel de gráficos. Ahora estoy agregando las categorías de gastos."],
      ["User", "Muy bien, sigue con las categorías y agrega una para transporte."]],
    expect: [[/Language: not mainly English/, "says plainly that it did not interpret the text"], [/Do first: My last message/, "still finds the unanswered message structurally"]] },
  { name: "typo-heavy user", rows: [
      ["User", "buid me a landing pagee for my bakery, it should have a menue sectoin and a contcat form"],
      ["Assistant", "I built the landing page with a menu section and a contact form in index.html and styles.css."],
      ["User", "the menue sectoin is not workng, the pictrues dont show"],
      ["Assistant", "I fixed the image paths in index.html so the menu pictures now show."]],
    expect: [[/menu section/i, "typos are shown as the words meant"], [/pictures|images/i, "keeps the picture problem"]] },
  { name: "agent cut off mid-sentence", rows: [
      ["User", "Refactor utils.py into a package with separate modules for dates, strings and files."],
      ["Assistant", "[tool use]"],
      ["Assistant", "I created utils/__init__.py, utils/dates.py and utils/strings.py. I'm now moving the file helpers into utils/files.py and updating the imports in main.py so that"]],
    expect: [[/was in the middle of — moving the file helpers/, "mid-job state"], [/cut off mid-sentence/, "notices the reply was cut off"], [/Hidden work: 1/, "counts the hidden tool step"]] },
  { name: "assistant asked a question, user never answered", rows: [
      ["User", "Help me choose a database for a small inventory app."],
      ["Assistant", "Which do you prefer, SQLite or PostgreSQL? SQLite is simpler for a small app; PostgreSQL scales better."]],
    expect: [[/Where it stopped/, "has a stop state"], [/SQLite/, "keeps the options"]] },
  { name: "user changes mind twice", rows: [
      ["User", "Build the dashboard with Chart.js."],
      ["Assistant", "Okay, I set up the dashboard with Chart.js."],
      ["User", "Actually use D3 instead of Chart.js, I need custom axes."],
      ["Assistant", "Switched the charts to D3 with custom axes."],
      ["User", "Hmm no, go back to Chart.js, D3 is too heavy for this."],
      ["Assistant", "Reverted to Chart.js."]],
    expect: [[/FINAL DECISIONS\n- Go back to Chart\.js/, "the only final decision is the latest one (Chart.js)"], [/SUPERSEDED, do not follow: Use D3/, "the D3 swap is shown as superseded"], [/D3[^\n]*(?:SUPERSEDED|REJECTED|replaced)|(?:SUPERSEDED|REJECTED)[^\n]*D3/i, "D3 is shown as rejected"]] },
  { name: "user picks an option the assistant listed", rows: [
      ["User", "How should I host my static site?"],
      ["Assistant", "Three options: A) GitHub Pages, free and simple; B) Netlify, with form handling; C) a VPS, full control but more work."],
      ["User", "Go with option B."],
      ["Assistant", "Great, I'll set up Netlify with a netlify.toml file."]],
    expect: [[/Go with option B \(= B: Netlify/, "the chosen option is named, not just 'option B'"]] },
  { name: "late goal change in a long chat", rows: [].concat(
      [["User", "Let's build a mobile app for tracking workouts."], ["Assistant", "Great. I created the project skeleton for the mobile app."]],
      Array.from({ length: 12 }, (_, i) => [["User", "Add screen number " + (i + 1) + " for exercise type " + (i + 1) + "."], ["Assistant", "Added screen " + (i + 1) + " in screens/screen" + (i + 1) + ".js."]]).flat(),
      [["User", "Actually forget the mobile app. We are making it a website instead."], ["Assistant", "Understood. I'm now converting the screens to React web pages."]]),
    expect: [[/website/i, "the new direction is in the notes"], [/Where it stopped:.*was in the middle of — converting the screens/, "knows what it was doing"], [/mobile app[^\n]*(?:SUPERSEDED|REJECTED|replaced)|(?:SUPERSEDED|REJECTED)[^\n]*mobile/i, "the old direction is marked replaced"]] },
  { name: "constraint hidden inside a question", rows: [
      ["User", "Can you write a script to rename my photos by date without using any external libraries?"],
      ["Assistant", "Yes. I wrote rename.py using only os and datetime."],
      ["User", "Now also handle videos."]],
    expect: [[/without using any external libraries|no external libraries|external libraries/i, "keeps the no-libraries constraint"]] },
  { name: "empty-ish / tiny chat", rows: [["User", "hi"], ["Assistant", "Hello! How can I help?"]],
    expect: [[/KEY NOTES|CAPSULE|hi/i, "does not crash on a tiny chat"]] },
];

function run(log) {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    let text = "";
    try { text = gen(c.rows); } catch (e) { fail++; console.log("  FAIL corpus: " + c.name + " crashed: " + e.message); continue; }
    for (const [re, why] of c.expect) {
      if (re.test(text)) pass++; else { fail++; console.log("  FAIL corpus [" + c.name + "]: " + why + "\n         expected " + re + (log ? "\n" + text + "\n" : "")); }
    }
  }
  return { pass, fail };
}
if (require.main === module) { const r = run(true); console.log(r.pass + " passed, " + r.fail + " failed"); process.exit(r.fail ? 1 : 0); }
module.exports = { run, CASES, gen };
