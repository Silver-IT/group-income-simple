'use strict'
import incomeDistribution from '~/frontend/utils/distribution/mincome-proportional.js'
import { lastDayOfMonth, dateFromMonthstamp, dateToMonthstamp } from '~/frontend/utils/time.js'

function simpleCopy (variable) {
  return JSON.parse(JSON.stringify(variable))
}

// Merges multiple payments between any combinations two of users:
function reduceDistribution (payments: Array<Object>): Array<Object> {
  // Don't modify the payments list/object parameter in-place, as this is not intended:
  payments = simpleCopy(payments)
  for (let i = 0; i < payments.length; i++) {
    const paymentA = payments[i]
    for (let j = i + 1; j < payments.length; j++) {
      const paymentB = payments[j]

      // Were paymentA and paymentB between the same two users?
      if ((paymentA.from === paymentB.from && paymentA.to === paymentB.to) ||
        (paymentA.to === paymentB.from && paymentA.from === paymentB.to)) {
        // Add or subtract paymentB's amount to paymentA's amount, depending on the relative
        // direction of the two payments:
        paymentA.amount += (paymentA.from === paymentB.from ? 1 : -1) * paymentB.amount
        paymentA.total += (paymentA.from === paymentB.from ? 1 : -1) * paymentB.total
        // Remove paymentB from payments, and decrement the inner sentinal loop variable:
        payments = payments.filter((payment) => payment !== paymentB)
        j--
      }
    }
  }
  return payments
}

// DRYing function meant for accumulating late payments from a previous cycle
function addDistributions (paymentsA: Array<Object>, paymentsB: Array<Object>): Array<Object> {
  return reduceDistribution([paymentsA, paymentsB].flat())
}

// DRYing function meant for chipping away a cycle's todoPayments distribution using that cycle's completedPayments:
function subtractDistributions (paymentsA: Array<Object>, paymentsB: Array<Object>): Array<Object> {
  // Don't modify any payment list/objects parameters in-place, as this is not intended:
  paymentsB = simpleCopy(paymentsB)

  // Reverse the sign of the second operand's amounts so that the final addition is actually subtraction:
  paymentsB = paymentsB.map((p) => {
    p.amount *= -1
    p.total *= -1
    return p
  })

  return addDistributions(paymentsA, paymentsB)
}

// This algorithm is responsible for calculating the monthly-rated distribution of
// payments.
function parseMonthlyDistributionFromEvents (distributionEvents: Array<Object>, minCome: number, adjusted: Boolean): Array<Object> {
  distributionEvents = simpleCopy(distributionEvents)

  // The following list variable is for DRYing out our calculations of the each cycle's final
  // income distributions.
  let groupMembers = []

  // Convenience function for retreiving a user by name:
  const getUser = name => groupMembers.find(member => member.name === name)

  // Forgiven late payments, and forgotten over payments:
  const forgivemory = {
    monthlyDistributions: [],
    completedPayments: []
  }
  const attentionSpan = 2 // Number of cycles (or months) of 'forgivemory'

  // Make a place to store this and preceding cycles' startCycleEvent (where over/under-payments are stored)
  // so that they can be included in the next cycle's payment distribution calculations:
  let cycleEvents = []
  let monthlyDistribution = [] // For each cycle's monthly distribution calculation
  let completedPayments = [] // For accumulating the payment events of each month's cycle.

  // Create a helper function that forgives income/leave/join events, without forgetting them
  // (for up to attentionSpan number of cycles):
  const forgiveWithoutForget = (member, fromSwitching, restoreAlso) => {
    const toFilter = (payment) => payment.to !== member.name
    const fromFilter = (payment) => payment.from !== member.name
    const forgiveWithFilter = (filter) => {
      forgivemory.completedPayments = forgivemory.completedPayments.map((cycleOverPayments, index) =>
        simpleCopy(cycleOverPayments.concat(cycleEvents[index].data.completedPayments.filter(filter)))
      )
      forgivemory.monthlyDistributions = forgivemory.completedPayments.map((cycleLatePayments, index) =>
        simpleCopy(cycleLatePayments.concat(cycleEvents[index].data.monthlyDistribution.filter(filter)))
      )
      cycleEvents = cycleEvents.map((cycleEvent) =>
        ({
          data: {
            when: cycleEvent.data.when,
            completedPayments: cycleEvent.data.completedPayments.filter((o) => !filter(o)),
            monthlyDistribution: cycleEvent.data.monthlyDistribution.filter((o) => !filter(o))
          }
        })
      )
    }
    const rememberWithFilter = (filter) => {
      cycleEvents = cycleEvents.map((cycleEvent) =>
        ({
          data: {
            when: cycleEvent.data.when,
            completedPayments: cycleEvent.data.completedPayments.filter(filter),
            monthlyDistribution: cycleEvent.data.monthlyDistribution.filter(filter)
          }
        })
      )
      forgivemory.completedPayments = forgivemory.completedPayments.map((cycleOverPayments, index) =>
        simpleCopy(cycleOverPayments.concat(cycleEvents[index].data.completedPayments.filter((o) => !filter(o))))
      )
      forgivemory.monthlyDistributions = forgivemory.completedPayments.map((cycleLatePayments, index) =>
        simpleCopy(cycleLatePayments.concat(cycleEvents[index].data.monthlyDistribution.filter((o) => !filter(o))))
      )
    }
    if ((member.haveNeed < 0 && fromSwitching) || (member.haveNeed > 0 && !fromSwitching)) {
      forgiveWithFilter(fromFilter) // Move payments FROM USER to forgivemory
      if (restoreAlso) {
        rememberWithFilter(toFilter) // Restore payments TO USER from forgivemory:
      }
    } else if ((member.haveNeed > 0 && fromSwitching) || (member.haveNeed < 0 && !fromSwitching)) {
      forgiveWithFilter(toFilter) // Move payments TO USER to forgivemory:
      if (restoreAlso) {
        rememberWithFilter(fromFilter) // Restore payments FROM USER to forgivemory:
      }
    }
  }

  // Create a helper function for calculating each cycle's payment distribution:
  const paymentsDistribution = function (groupMembers, minCome) {
    const groupIncomes = groupMembers.map((user) => {
      return {
        name: user.name,
        amount: minCome + user.haveNeed
      }
    })
    return incomeDistribution(groupIncomes, minCome)
  }

  // Create a helper function for handling each startCycleEvent:
  const handleCycleEvent = (event) => {
    monthlyDistribution = paymentsDistribution(groupMembers, minCome).map((payment) => {
      payment.total = payment.amount
      return payment
    })

    if (adjusted) {
      monthlyDistribution = subtractDistributions(monthlyDistribution, completedPayments)
    }

    monthlyDistribution.forEach((v) => {
      v.partial = (v.total !== v.amount)
    })

    forgivemory.completedPayments.unshift(completedPayments)
    forgivemory.monthlyDistributions.unshift(monthlyDistribution)

    if (forgivemory.completedPayments.length >= attentionSpan) forgivemory.completedPayments.pop()
    if (forgivemory.monthlyDistributions.length >= attentionSpan) forgivemory.monthlyDistributions.pop()

    const eventCopy = simpleCopy(event)
    eventCopy.data.completedPayments = completedPayments
    eventCopy.data.monthlyDistribution = monthlyDistribution
    cycleEvents.push(eventCopy)

    completedPayments = []
    monthlyDistribution = []
  }

  const handleIncomeEvent = (event) => {
    const oldUser = getUser(event.data.name)
    if (oldUser) {
      const switched = Math.sign(oldUser.haveNeed) !== Math.sign(event.data.haveNeed)
      oldUser.haveNeed = event.data.haveNeed
      if (switched) forgiveWithoutForget(oldUser, true, true)
    } else {
      // Add the user who declared their income to our groupMembers list variable
      groupMembers.push({
        name: event.data.name,
        haveNeed: event.data.haveNeed
      })
      forgiveWithoutForget(event.data, false, false)
    }
  }

  const handlePaymentEvent = (event) => {
    completedPayments.push({
      from: event.data.from,
      to: event.data.to,
      amount: event.data.amount,
      total: 0
    })
  }

  const handleExitEvent = (event) => {
    forgiveWithoutForget(event.data, false, false)
    groupMembers = groupMembers.filter((v) => { return v.name !== event.data.name })
  }

  // Loop through the events, pro-rating each user's monthly pledges/needs:
  distributionEvents.forEach((event) => {
    if (event.type === 'startCycleEvent') {
      handleCycleEvent(event)
    } else if (event.type === 'haveNeedEvent') {
      handleIncomeEvent(event)
    } else if (event.type === 'paymentEvent') {
      handlePaymentEvent(event)
    } else if (event.type === 'userExitsGroupEvent') {
      handleExitEvent(event)
    }
  })

  const lastWhen = distributionEvents[distributionEvents.length - 1].data.when

  const artificialEnd = {
    type: 'startCycleEvent',
    data: {
      when: lastWhen,
      monthlyDistribution: [], // List to be populated later, by the events-parser
      completedPayments: []
    }
  }
  handleCycleEvent(artificialEnd)

  let finalOverPayments = []
  cycleEvents.forEach((startCycleEvent, cycleIndex) => {
    // "Overpayments sometimes occur *internally* as a result of people leaving, joining, and (re-)setting income.
    // This routine is to redistribute the overpayments back into the current late payments so nobody in need is asked to pay.
    const overPayments = JSON.parse(JSON.stringify(startCycleEvent.data.monthlyDistribution)).filter((p) => {
      return p.amount < 0
    }).map((p) => {
      p.amount = Math.abs(p.amount)
      p.total = Math.abs(p.total)

      return p
    })
    finalOverPayments = addDistributions(finalOverPayments, overPayments)
  })

  const distribution = cycleEvents.reverse().map((startCycleEvent, cycleIndex) => {
    startCycleEvent.data.monthlyDistribution = subtractDistributions(startCycleEvent.data.monthlyDistribution, finalOverPayments)

    if (!adjusted) {
      startCycleEvent.data.monthlyDistribution = reduceDistribution(addDistributions(startCycleEvent.data.completedPayments, startCycleEvent.data.monthlyDistribution))
    }
    return startCycleEvent.data.monthlyDistribution.map((payment) => {
      payment.amount = Math.min(payment.amount, payment.total)
      payment.isLate = cycleIndex > 0
      payment.partial = payment.partial ? payment.partial : false
      payment.dueOn = dateToMonthstamp(lastDayOfMonth(dateFromMonthstamp(dateToMonthstamp(new Date(startCycleEvent.data.when)))))
      return payment
    })
  }).reverse().flat()

  return distribution.filter((payment) => {
    return payment.from !== payment.to // This happens when a haver switches to being a needer; remove neutral distribution payments.
  })
}

export default parseMonthlyDistributionFromEvents
