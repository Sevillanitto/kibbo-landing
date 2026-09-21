// Shared car-finance math used by the Cars & Vehicles calculators
// (Total Cost of Ownership + Lease vs Buy). One implementation so the two
// tools can never disagree about depreciation or loan amortization.
//
// Depreciation: value after year N = price x product of (1 - that year's
// rate). Default rates are the typical-new-car, industry-average curve
// (yr1 16%, yr2 12%, yr3 11%, yr4 9%, yr5 7%), each applied to the value
// remaining at the START of that year; years 6+ use a 5%/yr continuation
// that is our own estimate. Fractional years compound the partial year
// geometrically. A user-supplied flat % per year overrides the curve.
(function (root) {
  'use strict';

  var DEFAULT_DEPRECIATION_RATES = [0.16, 0.12, 0.11, 0.09, 0.07];
  var LATER_YEAR_DEPRECIATION_RATE = 0.05;

  function depreciationRateForYear(yearNumber) {
    return yearNumber <= DEFAULT_DEPRECIATION_RATES.length
      ? DEFAULT_DEPRECIATION_RATES[yearNumber - 1]
      : LATER_YEAR_DEPRECIATION_RATE;
  }

  // Fraction of the purchase price still worth something after `years`.
  // ownRatePct === null -> typical curve; a number -> flat % per year.
  function residualFraction(years, ownRatePct) {
    if (ownRatePct !== null) return Math.pow(1 - ownRatePct / 100, years);
    var fraction = 1;
    var fullYears = Math.floor(years);
    for (var y = 1; y <= fullYears; y++) fraction *= 1 - depreciationRateForYear(y);
    var partial = years - fullYears;
    if (partial > 0) fraction *= Math.pow(1 - depreciationRateForYear(fullYears + 1), partial);
    return fraction;
  }

  // Standard amortization payment; r=0 limit handled explicitly.
  function monthlyPayment(principal, monthlyRate, months) {
    if (monthlyRate === 0) return principal / months;
    var factor = Math.pow(1 + monthlyRate, months);
    return principal * (monthlyRate * factor) / (factor - 1);
  }

  // Walks the amortization schedule for `monthsElapsed` months (capped at
  // the loan term) and reports what has happened by then: the fixed
  // payment, how many payments were made, interest and principal paid so
  // far, and the balance still owed.
  function amortize(loanAmount, aprPct, termMonths, monthsElapsed) {
    var monthlyRate = aprPct / 100 / 12;
    var payment = monthlyPayment(loanAmount, monthlyRate, termMonths);
    var months = Math.min(termMonths, Math.max(0, monthsElapsed));
    var balance = loanAmount;
    var interest = 0;
    for (var m = 1; m <= months; m++) {
      var monthInterest = balance * monthlyRate;
      interest += monthInterest;
      balance -= payment - monthInterest;
    }
    // Clean up floating-point dust once the loan is fully repaid.
    if (months >= termMonths || balance < 1e-6) balance = 0;
    return {
      payment: payment,
      paymentsMade: months,
      interestPaid: interest,
      principalPaid: loanAmount - balance,
      balance: balance
    };
  }

  var api = {
    residualFraction: residualFraction,
    monthlyPayment: monthlyPayment,
    amortize: amortize
  };
  root.KibboCarFinance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
