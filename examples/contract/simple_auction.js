// Copyright (C) 2013 Vrije Universiteit Brussel
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/*
 * A smart contract for running auctions. Simple "first price sealed bid" auction:
 * bids are sealed, highest bidder wins and pays his/her price.
 *
 * Auctions are hosted by a third-party auctioneer, trusted by seller and bidders.
 * Seller and bidders are mutually suspicious and do not need to trust each other.
 *
 * Inspired by the paper "Distributed Electronic Rights in JavaScript":
 * https://code.google.com/p/es-lab/downloads/detail?name=distr-erights-in-js.pdf
 *
 * and the escrow exchange contract as first presented by Mark S. Miller in
 * the presentation "two phase commit among strangers":
 * https://code.google.com/p/es-lab/downloads/detail?name=friam.pdf
 *
 * @author Tom Van Cutsem
 */
define('contract/simple_auction', ['Q'], function(Q) {
  "use strict";
  const harden = require('@agoric/harden');

  var makeAuctioneer = function() {

    var auctions = new WeakMap(); // for rights amplification

    return harden({
    
      /**
       * minBid = minimum bid required by the seller (a number)
       * stopP  = promise signaling when it's time to stop the auction
       *          (race with a timebomb for timeouts)
       * seatP  = promise for the right to play an exchange contract trading money
       *          for the auctioned good
       */
      makeAuction: function(minBid, stopP, seatP) {
        var maxBid = +minBid;
        // resolveBidder refers to the "resolve" function of the promise
        // handed out to the highest bidder so far, if any
        var resolveBidder = undefined;
        var auctionToken = harden({});
      
        auctions.set(auctionToken, function(bid) {
          bid = +bid; // make sure bid is a number
          if (bid > maxBid) {
            if (resolveBidder !== undefined) {
              resolveBidder(Q.reject("bid too low. Minimum bid: " + bid));
            }
            return Q.promise( function(resolve,reject) {
              resolveBidder = resolve;
              maxBid = bid;
            });
          } else {
            throw new Error("bid too low. Minimum bid: " + maxBid));
          }
        });
      
        // when seller resolves the stop promise, it's time to stop the auction
        var outcomeP = Q(stopP).then( function(_) {
          // revoking the auctionToken ensures that any later bids will fail
          auctions.delete(auctionToken);
          if (resolveBidder === undefined) { throw new Error("no bids"); }
          resolveBidder(seatP);
          return maxBid;
        });

        return [ auctionToken, outcomeP ];
      },
    
      /**
       * auctionToken = token that allegedly identifies an auction hosted by
       *                this auctioneer.
       * bid = an alleged number that the bidder wants to bid
       */
      placeBid: function(auctionToken, bid) {
        return auctions.get(auctionToken)(bid);
      }
    
    });
  };



  var makeSeller = function() {
    return harden({
    
      /**
       * good = the good to auction
       * minimumBid = the minimum amount of money a bidder must bid
       * timeout = amount of time the auction should run
       * purse = purse in which to deposit highest bidder's price
       * auctioneer = a reference to the auctioneer on which to host the auction
       */
      sell: function(good, minimumBid, timeout, purse, auctioneer) {

        var assignSeat;
        var seatP = Q.promise( function(resolve, reject) { assignSeat = resolve; });

        var pairP = Q(auctioneer).send('makeAuction', minimumBid, Q.delay(timeout), seatP);
        pairP.then( function(tuple) {
          var auctionToken = tuple[0]; var outcomeP = tuple[1];
          // announce the auction by sharing the auctionToken publicly,
          // together with a description of the advertised good

          // then, wait for the auction to finish
          Q(outcomeP).then(
            function(maxBid) {
              // there was a bidder, willing to pay maxBid amount of money for the good
              // set up escrow exchange
              var tokensP = Q(contractHost).send('setup', escrowExchange);
              // I'm token 0, share token 1 with highest bidder
              tokensP.then( function(tokens) {
               assignSeat( tokens[1] );
               Q(contractHost).send('play', tokens[0], escrowExchange, 0,
                 Q.passByCopy({
                   moneyDstP: purse,
                   moneyNeeded: maxBid,
                   good: good,
                   cancellationP: ...
                 }));
              });
            },
            function(reason) { /* there was no bidder */ }
          )
        });

      }
    });
  };


  var makeBidder = function() {
    return harden({
    
      /**
       * goodDesc = a description of the good the bidder is interested in. This description
       *            should allow the escrow exchange contract to check that the auctioned
       *            good is indeed the good expected by the bidder
       * myBid = the amount of money the bidder is willing to bid
       * myPurse = the purse from which to pay the seller when winning the auction,
       *           must contain at least myBid amount of money
       * auctionToken = a token that uniquely identifies the auction in which to take part
       * auctioneer = a reference to the auctioneer that hosts the auction
       */ 
      bid: function(goodDesc, myBid, myPurse, auctionToken, auctioneer) {

        Q.then(Q(auctioneer).send('placeBid', auctionToken, myBid),
           function(seatP) {
             // won the bid: exchange myBid money for the advertised good via the seat
             Q(seatP).then( function(seat) {
               Q(contractHost).send('play', seat, escrowExchange, 1,
                 Q.passByCopy({
                   moneySrcP: myPurse,
                   goodDesc: goodDesc,
                   cancellationP: undefined /*...*/
                 }));
             });
           },
           function(reason) {
             // auctionToken is invalid (auction may have already finished), or,
             // lost the bid (in which case it makes sense to try again with a higher bid)
           }
        );

      }    
    });
  
  };

  return {
    makeAuctioneer: makeAuctioneer,
    makeSeller: makeSeller,
    makeBidder: makeBidder
  };

});
