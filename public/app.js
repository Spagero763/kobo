const CELO_HEX = "0xa4ec";
const CELO_ID = 42220;

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const naira = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v) => naira.format(Number(v || 0));
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

const NAIRA = new Set(["NGNm", "cNGN"]);
const shown = (s) => (s === "USDT" ? "USD₮" : s);
// Fees on dollars are fractions of a cent, and two decimals would print them as zero.
const money = (v, sym) => {
  const n = Number(v || 0);
  const body = n > 0 && n < 0.01 ? n.toFixed(4) : fmt(n);
  return NAIRA.has(sym) ? `₦${body}` : `$${body}`;
};
const CHIPS = { naira: ["1000", "5000", "20000"], dollar: ["1", "5", "20"] };
// Held back from Max when the fee comes out of the same token, sized above the
// fee ceiling so a Max send is never refused for the fee.
const MARGIN = { NGNm: 10, USDT: 0.1, USDC: 0.1, USDm: 0.1 };

/* Links carry a request or a proof. ?pay= fills the send form for whoever pays,
   ?check= fills the payment check for whoever was paid. Anything malformed is
   ignored rather than half applied. */
const params = new URLSearchParams(location.search);
const SYMBOLS = ["NGNm", "cNGN", "USDT", "USDC", "USDm"];
const isAddr = (v) => /^0x[a-fA-F0-9]{40}$/.test(v ?? "");
const isTx = (v) => /^0x[0-9a-fA-F]{64}$/.test(v ?? "");
const linkToken = SYMBOLS.includes(params.get("token")) ? params.get("token") : "NGNm";
const linkAmount = Number(params.get("amount")) > 0 ? params.get("amount") : "";
const incoming = {
  pay: isAddr(params.get("pay"))
    ? { to: params.get("pay"), amount: linkAmount, token: linkToken, note: (params.get("note") ?? "").slice(0, 60) }
    : null,
  check: isTx(params.get("check")) ? { hash: params.get("check"), amount: linkAmount, token: linkToken } : null,
};

async function copy(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const tmp = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(tmp);
    tmp.select();
    document.execCommand("copy");
    tmp.remove();
  }
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = label), 1600);
}

const state = { account: null, chainId: null, quote: null, feeInNaira: false, busy: false };

/* Wallets differ on Celo's fee currency field, and the difference is not a
   preference: MetaMask uses the Ethereum-compatible transaction format, which
   has no feeCurrency field at all, so it always charges CELO. MiniPay and
   Valora implement CIP-64 and take the fee from the token instead.

   This is only used to set expectations before signing. The field is sent
   regardless, because a wallet that ignores it is no worse off. */
function detectFeeSupport(provider) {
  if (!provider) return false;
  return Boolean(provider.isMiniPay || provider.isValora) || !provider.isMetaMask;
}

/* Distinguishes "this wallet refuses the feeCurrency field" from a genuine
   failure, so the retry never swallows a real error like a rejected signature
   or an empty balance. */
function rejectedFeeCurrency(e) {
  if (e?.code === 4001) return false;
  const raw = `${e?.message ?? ""} ${e?.data?.message ?? ""}`.toLowerCase();
  return (
    raw.includes("feecurrency") ||
    raw.includes("unknown parameter") ||
    raw.includes("invalid parameters") ||
    raw.includes("unsupported") ||
    raw.includes("unrecognized field")
  );
}

function setNet(kind, text) {
  $("netdot").className = `dot ${kind}`;
  $("nettext").textContent = text;
}

/* Wallet and node errors arrive as hex, nested cause chains, or vendor strings.
   None of that belongs in front of someone sending money. */
function plainError(e) {
  const raw = (e?.shortMessage || e?.details || e?.message || String(e || "")).toLowerCase();
  const code = e?.code;

  if (code === 4001 || raw.includes("user rejected") || raw.includes("user denied")) {
    return "You cancelled the transaction. Nothing was sent.";
  }
  if (code === 4902 || raw.includes("unrecognized chain")) {
    return "Celo is not set up in this wallet yet. Approve the prompt to add it.";
  }
  if (raw.includes("insufficient funds") || raw.includes("exceeds balance")) {
    return "Not enough balance to cover the amount plus the fee.";
  }
  if (raw.includes("gas required exceeds allowance")) {
    return "Your wallet could not estimate the fee. Try a slightly smaller amount.";
  }
  if (raw.includes("fee cap") || raw.includes("max fee per gas")) {
    return "The network got busy while you were signing. Try again.";
  }
  if (raw.includes("nonce")) {
    return "Another transaction from this wallet is still pending. Wait for it to finish.";
  }
  if (raw.includes("transfer amount exceeds balance")) {
    return "Your balance moved before this went through. Check it and try again.";
  }
  if (raw.includes("failed to fetch") || raw.includes("network error") || raw.includes("timeout")) {
    return "Could not reach the network. Check your connection and try again.";
  }
  return "The transaction did not go through. Nothing was sent.";
}

const ICONS = {
  spin: '<div class="spinner"></div>',
  ok: '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><path d="M6 10.4l2.7 2.6L14 7.6"/></svg>',
  bad: '<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="8.5"/><path d="M10 6v5M10 14h.01"/></svg>',
};

function status(kind, msg, sub = "") {
  const box = $("status");
  $("status-ic").innerHTML = kind === "work" ? ICONS.spin : kind === "ok" ? ICONS.ok : ICONS.bad;
  $("status-msg").textContent = msg;
  $("status-sub").innerHTML = sub;
  const first = !box.classList.contains("on");
  box.classList.add("on");
  // Motion marks that the state changed. It never runs long enough to wait on.
  if (window.gsap && !reduced) {
    gsap.fromTo(box, { opacity: first ? 0 : 1, y: first ? 4 : 0 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" });
  }
}

function clearStatus() {
  $("status").classList.remove("on");
}

/* Three fixed stages: signed, mined, confirmed. Progress is a claim about where
   the transaction is, so it only ever moves forward when that is true. */
function step(n) {
  const bars = $("steps").querySelectorAll("i");
  $("steps").hidden = false;
  bars.forEach((bar, i) => {
    const done = i < n;
    if (window.gsap && !reduced) {
      gsap.to(bar, { scaleX: done ? 1 : 0, duration: 0.3, ease: "power2.out" });
    } else {
      bar.style.transform = `scaleX(${done ? 1 : 0})`;
    }
  });
}

function provider() {
  return window.ethereum ?? null;
}

/* Reads the balance of whichever token is selected. It has to follow the picker:
   showing an NGNm balance under a cNGN heading would have someone try to send
   money they do not hold, and Max would fill from the wrong token. */
async function loadBalance() {
  if (!state.account) return;
  const el = $("bal");
  const symbol = $("token")?.value ?? "NGNm";
  $("bal-unit").textContent = shown(symbol);
  el.classList.add("skel");
  try {
    const res = await fetch(`/v1/send/${symbol}/balance/${state.account}`);
    if (!res.ok) throw new Error("balance unavailable");
    const { balance } = await res.json();
    el.textContent = fmt(balance);
    el.dataset.raw = balance;
    el.dataset.token = symbol;
    // The add cash link only works inside MiniPay, so it is only offered there.
    $("bal-empty").hidden = Number(balance) > 0 || !provider()?.isMiniPay;
  } catch {
    $("bal-empty").hidden = true;
    el.textContent = "unavailable";
    el.dataset.raw = "";
    el.dataset.token = "";
  } finally {
    el.classList.remove("skel");
  }
}

async function ensureCelo() {
  const p = provider();
  const current = await p.request({ method: "eth_chainId" });
  state.chainId = parseInt(current, 16);
  if (state.chainId === CELO_ID) {
    setNet("live", "Celo");
    return true;
  }
  setNet("bad", "Wrong network");
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_HEX }] });
  } catch (e) {
    if (e?.code === 4902) {
      await p.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CELO_HEX,
          chainName: "Celo",
          nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
          rpcUrls: ["https://forno.celo.org"],
          blockExplorerUrls: ["https://celoscan.io"],
        }],
      });
    } else {
      throw e;
    }
  }
  state.chainId = CELO_ID;
  setNet("live", "Celo");
  return true;
}

async function connect() {
  const p = provider();
  if (!p) {
    status("bad", "No wallet found.", "Open this page inside MiniPay, or install a Celo-compatible wallet.");
    return;
  }
  try {
    clearStatus();
    $("connect").disabled = true;
    $("connect").textContent = "Check your wallet";
    const accounts = await p.request({ method: "eth_requestAccounts" });
    state.account = accounts[0];
    state.feeInNaira = detectFeeSupport(p);
    await ensureCelo();

    $("addr").textContent = short(state.account);
    $("connect-wrap").hidden = true;
    $("start-card").hidden = true;
    $("cost-card").hidden = true;
    $("proof-card").hidden = true;
    $("tabs").hidden = false;
    showTab("send");
    applyIncoming();
    await loadBalance();
    showVerifyState();

    const note = $("gasnote");
    if (state.feeInNaira) {
      note.classList.add("hide");
    } else {
      note.classList.remove("hide");
      note.textContent =
        "MetaMask cannot pay fees in naira or dollars. It uses the Ethereum transaction format, which has no field for it, so this send will need a small CELO balance. Open Kobo in MiniPay or Valora and the fee comes out of what you are sending instead.";
    }
  } catch (e) {
    status("bad", plainError(e));
  } finally {
    $("connect").disabled = false;
    $("connect").textContent = "Connect wallet";
  }
}

let quoteTimer;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(refreshQuote, 260);
}

function validate() {
  const to = $("to").value.trim();
  const amt = $("amt").value.trim();
  let ok = true;

  const toBad = to.length > 0 && !/^0x[a-fA-F0-9]{40}$/.test(to);
  $("to-err").textContent = toBad ? "That is not a valid Celo address." : "";
  $("to").setAttribute("aria-invalid", String(toBad));
  if (toBad || !to) ok = false;

  const n = Number(amt);
  const amtBad = amt.length > 0 && (!isFinite(n) || n <= 0);
  $("amt-err").textContent = amtBad ? "Enter an amount greater than zero." : "";
  $("amt").setAttribute("aria-invalid", String(amtBad));
  if (amtBad || !amt) ok = false;

  return ok;
}

async function refreshQuote() {
  const btn = $("send");
  if (!validate()) {
    $("quote").classList.remove("on");
    state.quote = null;
    btn.disabled = true;
    btn.textContent = $("amt").value.trim() ? "Check the details" : "Enter an amount";
    return;
  }
  const token = $("token").value;
  try {
    const url = `/v1/send/${token}/quote?from=${state.account}&to=${$("to").value.trim()}&amount=${$("amt").value.trim()}`;
    const res = await fetch(url);
    const q = await res.json();
    if (!res.ok) throw new Error(q.error || "quote failed");

    state.quote = q;

    /* The fee currency is whatever the server found in this wallet, so it is
       not always naira. Naming it wrongly would tell someone their dollars are
       naira, so every figure below is labelled with what it actually is. */
    const fee = q.feeCurrency ?? "NGNm";

    $("q-arrives").textContent = `${money(q.arrives, token)} ${shown(token)}`;
    $("q-fee").textContent = `${money(q.estimatedFee, fee)} ${fee}`;
    $("q-total").textContent = q.feeInSameToken
      ? `${money(Number(q.amount) + Number(q.estimatedFee), token)} ${shown(token)}`
      : `${money(q.amount, token)} ${shown(token)} and ${money(q.estimatedFee, fee)} ${fee}`;
    $("quote").classList.add("on");

    const note = $("token-note");
    if (q.note) {
      note.textContent = q.note;
      note.classList.remove("hide");
    } else {
      note.classList.add("hide");
    }

    const canSend = q.sufficient && q.gasSufficient !== false;
    btn.disabled = !canSend;
    btn.textContent = !q.sufficient
      ? `Not enough ${shown(token)}`
      : q.gasSufficient === false
        ? "Nothing here can pay the fee"
        : `Send ${money(q.amount, token)}`;
  } catch (e) {
    state.quote = null;
    $("quote").classList.remove("on");
    btn.disabled = true;
    btn.textContent = "Could not price this";
    $("amt-err").textContent = plainError(e);
  }
}

async function submit() {
  if (state.busy || !state.quote) return;
  const p = provider();
  state.busy = true;
  $("send").disabled = true;

  try {
    await ensureCelo();

    const res = await fetch(`/v1/send/${$("token").value}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // from lets the server pick the fee currency out of what this wallet
      // actually holds, rather than assuming naira is there.
      body: JSON.stringify({
        from: state.account,
        to: $("to").value.trim(),
        amount: $("amt").value.trim(),
      }),
    });
    const built = await res.json();
    if (!res.ok) throw new Error(built.error || "could not build the transfer");

    /* Always ask for the fee in a token, using whichever one the server picked
       from this wallet's balances. Wallets that implement CIP-64 honour it;
       MetaMask uses the Ethereum-compatible format that has no feeCurrency
       field and drops it, which costs nothing to try. */
    const tx = {
      from: state.account,
      to: built.transaction.to,
      data: built.transaction.data,
      gas: built.transaction.gas,
      feeCurrency: built.transaction.feeCurrency,
    };

    step(0);
    status("work", "Confirm in your wallet.", "Nothing moves until you approve it.");

    let hash;
    try {
      hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
    } catch (e) {
      // A wallet that validates strictly rejects the field rather than ignoring
      // it. Retrying without it still sends the money, just with CELO for gas,
      // which beats failing outright on a wallet we cannot predict.
      if (!rejectedFeeCurrency(e)) throw e;
      delete tx.feeCurrency;
      status("work", "This wallet cannot pay the fee in naira.", "Retrying with CELO for gas.");
      hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
    }

    step(1);
    const link = `<a href="https://celoscan.io/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
    status("work", "Sent. Waiting for the network.", link);

    const receipt = await waitForReceipt(p, hash);
    if (receipt.status === "0x0" || receipt.status === 0) {
      step(1);
      status("bad", "The network rejected the transfer.", link);
      return;
    }

    step(3);
    // Proof they can open themselves beats a screenshot, which is exactly what
    // a fake alert looks like.
    const proof = `${location.origin}/?${new URLSearchParams({ check: hash, token: state.quote.token, amount: state.quote.amount })}`;
    const said = `I have sent you ${money(state.quote.amount, state.quote.token)} ${shown(state.quote.token)}. Check it landed: ${proof}`;
    status(
      "ok",
      `${money(state.quote.amount, state.quote.token)} ${shown(state.quote.token)} sent.`,
      `${link} · <a href="https://wa.me/?text=${encodeURIComponent(said)}" target="_blank" rel="noopener">Send them proof on WhatsApp</a>`,
    );
    $("amt").value = "";
    $("quote").classList.remove("on");
    await loadBalance();
  } catch (e) {
    status("bad", plainError(e));
    $("steps").hidden = true;
  } finally {
    state.busy = false;
    refreshQuote();
  }
}

/* Celo finalises in one block, so a single confirmation is final. Polling stops
   after roughly two minutes rather than spinning forever. */
async function waitForReceipt(p, hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r) {
      step(2);
      return r;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("timeout");
}

$("connect").addEventListener("click", connect);
$("send").addEventListener("click", submit);
$("to").addEventListener("input", scheduleQuote);
$("amt").addEventListener("input", scheduleQuote);
function setChips() {
  const token = $("token").value;
  const amounts = CHIPS[NAIRA.has(token) ? "naira" : "dollar"];
  document.querySelectorAll("[data-amt]").forEach((b, i) => {
    b.dataset.amt = amounts[i];
    b.textContent = money(amounts[i], token).replace(/\.00$/, "");
  });
}

$("token").addEventListener("change", () => {
  $("amt").value = "";
  $("quote").classList.remove("on");
  setChips();
  loadBalance();
  scheduleQuote();
});

document.querySelectorAll("[data-amt]").forEach((b) =>
  b.addEventListener("click", () => {
    $("amt").value = b.dataset.amt;
    scheduleQuote();
  }),
);

$("chip-max").addEventListener("click", () => {
  const el = $("bal");
  const raw = el.dataset.raw;
  if (!raw || el.dataset.token !== $("token").value) return;

  /* Only hold back a fee margin when the fee can come out of this same token.
     cNGN cannot pay its own gas, so the whole cNGN balance is spendable and
     reserving from it would strand money for no reason. */
  const margin = MARGIN[$("token").value] ?? 0;
  $("amt").value = Math.max(0, Number(raw) - margin).toFixed(2);
  scheduleQuote();
});

const p = provider();
if (p) {
  setNet("", "Not connected");
  p.on?.("accountsChanged", (a) => {
    state.account = a[0] ?? null;
    if (!state.account) location.reload();
    else {
      $("addr").textContent = short(state.account);
      loadBalance();
    }
  });
  p.on?.("chainChanged", () => location.reload());
  // MiniPay authorises the page already, so skip the connect step there.
  if (p.isMiniPay) connect();
} else {
  // No wallet in this browser. The start card offers the ways in, so a dead
  // button would only be in the way.
  setNet("bad", "No wallet");
  $("connect").hidden = true;
  $("start-open").hidden = false;
  $("start-minipay").href = `https://link.minipay.xyz/browse?url=${encodeURIComponent(location.href)}`;
  $("start-copy").addEventListener("click", () => copy(location.href, $("start-copy"), "Copy link"));

  // A phone camera is the quickest way from a laptop to a wallet.
  if (matchMedia("(min-width: 700px)").matches) {
    fetch(`/v1/qr?path=${encodeURIComponent(location.pathname + location.search)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b) return;
        $("start-qr").innerHTML = b.qr;
        $("start-qr-wrap").hidden = false;
      })
      .catch(() => {});
  }
}

function showIncoming() {
  const r = incoming.pay;
  if (!r) return;
  $("req-card").hidden = false;
  $("req-amount").textContent = r.amount
    ? `${money(r.amount, r.token).replace(/\.00$/, "")} ${shown(r.token)}`
    : `Any amount of ${shown(r.token)}`;
  $("req-note").textContent = r.note ? `For ${r.note}` : "";
  $("req-note").hidden = !r.note;
  $("req-to").textContent = r.to;
}

function applyIncoming() {
  if (incoming.pay) {
    const r = incoming.pay;
    $("token").value = r.token;
    setChips();
    $("to").value = r.to;
    $("amt").value = r.amount;
    showTab("send");
    scheduleQuote();
  } else if (incoming.check) {
    showTab("check");
    $("ck-hash").value = incoming.check.hash;
    $("ck-token").value = incoming.check.token;
    $("ck-amt").value = incoming.check.amount;
  }
}

showIncoming();

$("rq-make").addEventListener("click", async () => {
  const amount = $("rq-amt").value.trim();
  const token = $("rq-token").value;
  const note = $("rq-note").value.trim();
  $("rq-err").textContent = "";
  if (amount && !(Number(amount) > 0)) {
    $("rq-err").textContent = "Enter an amount greater than zero, or leave it empty.";
    return;
  }
  try {
    const q = new URLSearchParams({ to: state.account, token });
    if (amount) q.set("amount", amount);
    if (note) q.set("note", note);
    const r = await fetch(`/v1/request?${q}`);
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || "could not make the link");
    $("rq-qr").innerHTML = b.qr;
    $("rq-link").value = b.link;
    $("rq-wa").href = `https://wa.me/?text=${encodeURIComponent(b.text)}`;
    $("rq-out").hidden = false;
  } catch (e) {
    $("rq-err").textContent = e.message;
  }
});

$("rq-copy").addEventListener("click", () => copy($("rq-link").value, $("rq-copy"), "Copy link"));

/* Tabs. Everything below the balance lives in one of four panels, so the page
   shows one job at a time instead of a column of cards. */
function showTab(name) {
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
  });
  if (name === "you") showVerifyState();
  if (name === "check" && !$("ck-to").value && state.account) $("ck-to").value = state.account;
}

document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)),
);

/* A status box per panel, so a message about a circle cannot appear under the
   send form. */
function panelStatus(prefix, kind, msg, sub = "") {
  const box = $(`${prefix}-status`);
  if (!box) return;
  $(`${prefix}-status-ic`).innerHTML = kind === "work" ? ICONS.spin : kind === "ok" ? ICONS.ok : ICONS.bad;
  $(`${prefix}-status-msg`).textContent = msg;
  $(`${prefix}-status-sub`).innerHTML = sub;
  box.classList.add("on");
}

/* Signs a prepared transaction and waits for it. Every write in the app goes
   through here so they behave the same way. */
async function signAndWait(built, prefix, working, done) {
  const p = provider();
  await ensureCelo();
  const tx = { from: state.account, to: built.to, data: built.data, gas: built.gas };
  if (state.feeInNaira && built.feeCurrency) tx.feeCurrency = built.feeCurrency;

  panelStatus(prefix, "work", working);
  const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
  const link = `<a href="https://celoscan.io/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>`;
  panelStatus(prefix, "work", "Waiting for the network.", link);

  const receipt = await waitForReceipt(p, hash);
  if (receipt.status === "0x0" || receipt.status === 0) {
    panelStatus(prefix, "bad", "The network rejected it.", link);
    return null;
  }
  panelStatus(prefix, "ok", done, link);
  return hash;
}

/* Proof of personhood. The proof is produced on the person's phone and lands
   onchain without touching this page, so there is nothing to submit here: we
   ask the contract until it says yes. */
let verifyPoll = null;

async function refreshVerified() {
  if (!state.account) return null;
  try {
    const r = await fetch(`/v1/personhood/${state.account}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function showVerifyState() {
  const card = $("verify-card");
  const s = await refreshVerified();
  // Hidden entirely when the contract is not configured, rather than offering
  // a button that cannot work.
  if (!s?.configured) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("v-done").hidden = !s.verified;
  $("v-idle").hidden = s.verified;
  if (s.verified) {
    $("v-qr").hidden = true;
    if (verifyPoll) {
      clearInterval(verifyPoll);
      verifyPoll = null;
    }
  }
}

async function startVerify() {
  if (!state.account) return;
  const btn = $("v-start");
  btn.disabled = true;
  btn.textContent = "Preparing";
  try {
    const r = await fetch(`/v1/personhood/${state.account}/link`);
    if (!r.ok) throw new Error((await r.json()).error || "could not start");
    const { link, qr } = await r.json();

    $("v-qr-img").innerHTML = qr;
    $("v-open").href = link;
    $("v-idle").hidden = true;
    $("v-qr").hidden = false;

    // The page never sees the proof, so the chain is the only source of truth.
    verifyPoll = setInterval(async () => {
      const s = await refreshVerified();
      if (s?.verified) showVerifyState();
    }, 4000);
  } catch (e) {
    status("bad", plainError(e));
    btn.disabled = false;
    btn.textContent = "Prove I am a person";
  }
}

$("v-start").addEventListener("click", startVerify);

/* Paying in another currency. The fee is fixed rather than proportional, so on
   a small amount it is a large share and the quote says so plainly. */
let abTimer = null;
let abQuote = null;

async function loadAbroadQuote() {
  const to = $("ab-to").value.trim();
  const amount = $("ab-amt").value.trim();
  const symbol = $("ab-cur").value;
  const btn = $("ab-send");

  abQuote = null;
  btn.disabled = true;
  if (!to || !amount || Number(amount) <= 0) {
    btn.textContent = "Enter an amount";
    return;
  }

  btn.textContent = "Checking";
  try {
    const r = await fetch(
      `/v1/quote/cross?from=${state.account}&to=${symbol}&amount=${encodeURIComponent(amount)}`,
    );
    const q = await r.json();
    if (!r.ok) throw new Error(q.error || "could not quote");

    $("ab-arrives").textContent = `${Number(q.arrives).toFixed(2)} ${q.to}`;
    // The rate is how much of the destination one naira buys, so it reads
    // better inverted: what a unit of their currency costs in naira.
    $("ab-rate").textContent = `₦${fmt(1 / Number(q.rate))} per ${q.to}`;
    $("ab-fee").textContent = `₦${fmt(q.estimatedFee)} (${q.feeSharePct}%)`;
    $("ab-total").textContent = `₦${fmt(Number(amount) + Number(q.estimatedFee))}`;

    const note = $("ab-note");
    if (q.advice) {
      note.textContent = q.advice;
      note.classList.remove("hide");
    } else {
      note.classList.add("hide");
    }

    abQuote = q;
    btn.disabled = !q.sufficient;
    btn.textContent = q.sufficient ? `Send ₦${fmt(amount)}` : "Not enough naira";
  } catch (e) {
    $("ab-note").textContent = e.message;
    $("ab-note").classList.remove("hide");
    btn.textContent = "Enter an amount";
  }
}

const scheduleAbroad = () => {
  clearTimeout(abTimer);
  abTimer = setTimeout(loadAbroadQuote, 400);
};

$("ab-to").addEventListener("input", scheduleAbroad);
$("ab-amt").addEventListener("input", scheduleAbroad);
$("ab-cur").addEventListener("change", scheduleAbroad);
document.querySelectorAll("[data-abamt]").forEach((b) =>
  b.addEventListener("click", () => {
    $("ab-amt").value = b.dataset.abamt;
    scheduleAbroad();
  }),
);

$("ab-send").addEventListener("click", async () => {
  if (state.busy || !abQuote) return;
  state.busy = true;
  $("ab-send").disabled = true;
  try {
    const r = await fetch("/v1/send-as/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: $("ab-cur").value,
        amount: $("ab-amt").value.trim(),
        recipient: $("ab-to").value.trim(),
      }),
    });
    const built = await r.json();
    if (!r.ok) throw new Error(built.error || "could not build it");

    // Two signatures: the contract has to be allowed to take the naira before
    // it can swap it. The approval is for exactly this amount, never unlimited.
    const approved = await signAndWait(built.approve, "ab", "Allowing Kobo to take this naira.", "Approved.");
    if (!approved) return;
    const hash = await signAndWait(built.send, "ab", `Sending. They receive about ${Number(built.expected).toFixed(2)}.`, "Sent.");
    if (hash) {
      $("ab-amt").value = "";
      await loadBalance();
    }
  } catch (e) {
    panelStatus("ab", "bad", plainError(e));
  } finally {
    state.busy = false;
    $("ab-send").disabled = false;
    loadAbroadQuote();
  }
});

/* Savings circles. Membership lives in the contract; the money never touches
   it, so everything here is either a read or a transaction the member signs. */
async function openCircle(id) {
  const view = $("ci-view");
  $("ci-err").textContent = "";
  view.hidden = true;

  try {
    const r = await fetch(`/v1/circles/${id}`);
    const c = await r.json();
    if (!r.ok) throw new Error(c.error || "no circle with that id");

    const dues = state.account
      ? await fetch(`/v1/circles/${id}/dues/${state.account}`).then((x) => (x.ok ? x.json() : null))
      : null;

    const mine = c.members.some((m) => m.address.toLowerCase() === state.account?.toLowerCase());
    const rows = c.members
      .map((m, i) => {
        const turn = c.started
          ? i === c.round
            ? '<span class="pill on">collecting now</span>'
            : `<span class="turn">round ${i + 1}</span>`
          : `<span class="turn">round ${i + 1}</span>`;
        const you = m.address.toLowerCase() === state.account?.toLowerCase() ? " (you)" : "";
        return `<div class="member"><div class="who"><strong>${m.name || "Member"}${you}</strong><span class="turn mono">${short(m.address)}</span></div>${turn}</div>`;
      })
      .join("");

    let action = "";
    if (!c.started && !mine) {
      action = `<button class="primary" id="ci-join" style="margin-top:14px">Join this circle</button>`;
    } else if (!c.started && mine && c.organiser.toLowerCase() === state.account?.toLowerCase()) {
      action =
        c.members.length >= 2
          ? `<button class="primary" id="ci-start" style="margin-top:14px">Start it</button>`
          : `<p class="why">Waiting for at least one more member before it can start.</p>`;
    } else if (dues?.owed) {
      action = `<button class="primary" id="ci-pay" style="margin-top:14px">Pay ₦${fmt(dues.amount)} to ${dues.recipientName || "this round"}</button>`;
    } else if (dues?.collecting) {
      action = `<p class="why">It is your turn. The others pay you directly this round.</p>`;
    } else if (dues?.paid) {
      action = `<p class="why">You have paid this round.</p>`;
    }

    view.innerHTML = `
      <div class="bal-label" style="margin-top:18px">${c.members[0]?.name || "Circle"}</div>
      <dl class="cost">
        <div class="row"><dt>Each round</dt><dd>₦${fmt(c.amount)}</dd></div>
        <div class="row"><dt>Members</dt><dd>${c.members.length}</dd></div>
        <div class="row"><dt>Status</dt><dd>${c.started ? `round ${c.round + 1} of ${c.roundsTotal}` : "not started"}</dd></div>
      </dl>
      <div style="margin-top:14px">${rows}</div>
      ${action}
      <div class="status" id="cx-status" role="status" aria-live="polite">
        <div class="ic" id="cx-status-ic"></div>
        <div><div class="msg" id="cx-status-msg"></div><div class="sub" id="cx-status-sub"></div></div>
      </div>`;
    view.hidden = false;

    $("ci-join")?.addEventListener("click", async () => {
      const name = prompt("What should the others call you?") || "Member";
      const r2 = await fetch(`/v1/circles/${id}/build/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const b = await r2.json();
      if (!r2.ok) return panelStatus("cx", "bad", b.error || "could not join");
      if (await signAndWait(b.transaction, "cx", "Joining.", "You are in.")) openCircle(id);
    });

    $("ci-start")?.addEventListener("click", async () => {
      const r2 = await fetch(`/v1/circles/${id}/build/start`, { method: "POST" });
      const b = await r2.json();
      if (!r2.ok) return panelStatus("cx", "bad", b.error || "could not start");
      if (await signAndWait(b.transaction, "cx", "Starting.", "Started.")) openCircle(id);
    });

    $("ci-pay")?.addEventListener("click", async () => {
      if (await signAndWait(dues.transaction, "cx", "Paying.", "Paid.")) {
        await loadBalance();
        openCircle(id);
      }
    });
  } catch (e) {
    $("ci-err").textContent = e.message;
  }
}

$("ci-open").addEventListener("click", () => {
  const id = $("ci-id").value.trim();
  if (id) openCircle(id);
});

$("ci-create").addEventListener("click", async () => {
  const name = $("ci-name").value.trim();
  const amount = $("ci-amt").value.trim();
  const interval = $("ci-int").value;
  if (!name || !(Number(amount) > 0)) {
    return panelStatus("ci", "bad", "It needs a name and an amount.");
  }
  try {
    const r = await fetch("/v1/circles/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organiser: state.account, name, amount, interval: Number(interval) }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || "could not create it");
    if (await signAndWait(b.transaction, "ci", "Creating.", "Created.")) {
      $("ci-id").value = b.id;
      panelStatus("ci", "ok", "Created. Share the id below so others can join.", `<span class="mono">${b.id}</span>`);
      openCircle(b.id);
    }
  } catch (e) {
    panelStatus("ci", "bad", plainError(e));
  }
});

/* Checking a payment. It costs a cent over x402: the wallet signs a USD₮ or
   USDC authorisation, the Celo facilitator settles it, and nobody needs gas. */
const PAY_ASSETS = {
  "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e": "USDT",
  "0xceba9300f2b948710d2653dd7b07f33a8b32118c": "USDC",
};
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const unb64 = (s) => JSON.parse(decodeURIComponent(escape(atob(s))));
const nonce = () => "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function payFor(path) {
  const first = await fetch(path);
  if (first.status !== 402) return first;
  const challenge = unb64(first.headers.get("PAYMENT-REQUIRED"));

  // Pay in whichever of the accepted dollars this wallet actually has.
  const options = await Promise.all(
    challenge.accepts.map(async (a) => {
      const sym = PAY_ASSETS[a.asset.toLowerCase()];
      if (!sym) return null;
      const r = await fetch(`/v1/send/${sym}/balance/${state.account}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      return r && Number(r.balance) * 1e6 >= Number(a.amount) ? { a, sym } : null;
    }),
  );
  const pick = options.find(Boolean);
  if (!pick) throw new Error("A check costs $0.01 in USD₮ or USDC, and this wallet holds neither.");

  const { a, sym } = pick;
  const authorization = {
    from: state.account,
    to: a.payTo,
    value: a.amount,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + (a.maxTimeoutSeconds ?? 300)),
    nonce: nonce(),
  };
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: { name: a.extra.name, version: a.extra.version, chainId: CELO_ID, verifyingContract: a.asset },
    message: authorization,
  };

  panelStatus("ck", "work", `Sign $0.01 in ${shown(sym)}.`, "A signature, not a transaction. No gas.");
  const signature = await provider().request({
    method: "eth_signTypedData_v4",
    params: [state.account, JSON.stringify(typed)],
  });

  panelStatus("ck", "work", "Reading the chain.");
  const header = b64({ x402Version: challenge.x402Version ?? 2, payload: { authorization, signature }, resource: challenge.resource, accepted: a });
  return fetch(path, { headers: { "PAYMENT-SIGNATURE": header } });
}

$("ck-go").addEventListener("click", async () => {
  const hash = $("ck-hash").value.trim();
  const to = $("ck-to").value.trim();
  const amount = $("ck-amt").value.trim();
  const token = $("ck-token").value;

  $("ck-hash-err").textContent = /^0x[0-9a-fA-F]{64}$/.test(hash) ? "" : "A transaction hash is 0x followed by 64 characters.";
  $("ck-to-err").textContent = /^0x[a-fA-F0-9]{40}$/.test(to) ? "" : "That is not a valid Celo address.";
  if ($("ck-hash-err").textContent || $("ck-to-err").textContent || state.busy) return;

  state.busy = true;
  $("ck-go").disabled = true;
  $("ck-result").hidden = true;
  try {
    await ensureCelo();
    const q = new URLSearchParams({ to, token });
    if (Number(amount) > 0) q.set("amount", amount);
    const res = await payFor(`/v1/receipt/${hash}?${q}`);
    const r = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(r.error || (res.status === 402 ? "The payment did not go through, so nothing was charged." : "The check did not complete."));
    }

    const settled = res.headers.get("PAYMENT-RESPONSE");
    const paidTx = settled ? unb64(settled).transaction : null;
    const links = [
      r.found ? `<a href="https://celoscan.io/tx/${hash}" target="_blank" rel="noopener">their transaction</a>` : "",
      paidTx ? `<a href="https://celoscan.io/tx/${paidTx}" target="_blank" rel="noopener">your $0.01</a>` : "",
    ].filter(Boolean).join(" · ");
    panelStatus("ck", r.paid ? "ok" : "bad", r.verdict, links);

    if (r.found && r.status && r.status !== "pending") {
      const rows = [
        ["Status", r.status],
        ["When", new Date(r.time).toLocaleString()],
        ["Confirmations", r.confirmations],
        ["Arrived", r.received !== undefined ? `${money(r.received, token)} ${shown(token)}` : null],
        ["Sent from", short(r.from)],
        ["Fee paid in", r.fee?.currency],
      ].filter(([, v]) => v !== null && v !== undefined);
      $("ck-result").innerHTML = `<dl class="cost">${rows.map(([k, v]) => `<div class="row"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
      $("ck-result").hidden = false;
    }
  } catch (e) {
    panelStatus("ck", "bad", e?.code ? plainError(e) : e.message);
  } finally {
    state.busy = false;
    $("ck-go").disabled = false;
  }
});

/* What a transfer costs, before any wallet exists. The fee does not depend on
   who is asking, so making someone connect first to find out is backwards. */
async function loadCost() {
  const card = $("cost-card");
  try {
    const r = await fetch("/v1/cost?amount=5000");
    if (!r.ok) throw new Error();
    const c = await r.json();

    $("c-amount").textContent = `₦${fmt(c.example)}`;
    $("c-arrives").textContent = `₦${fmt(c.arrives)}`;
    $("c-fee").textContent = `₦${fmt(c.estimatedFee)}`;
    $("c-total").textContent = `₦${fmt(c.total)}`;
    for (const id of ["c-arrives", "c-fee", "c-total"]) $(id).classList.remove("skel");

    if (!c.nairaAcceptedAsGas) {
      $("c-note").textContent =
        "Celo is not accepting naira for gas right now, so a transfer would need CELO. This is read from the chain on every load.";
    }
  } catch {
    // Better to remove the panel than to leave dashes where numbers belong,
    // which is the exact complaint that produced it.
    card.hidden = true;
  }
}

loadCost();
