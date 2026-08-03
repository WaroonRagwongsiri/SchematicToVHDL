"use strict";

const WIRE_MINLEG = 22;
const GRAB_CLEAR = WIRE_MINLEG;

/*
Move:

Wire creation:
- onPortClick()
- pendingLastPoint()
- addWireCorner()
- finishWireInSpace()
- tapWire()
- startWireBranch()
- createJunctionOnWire()
- splitWireThroughJunction()
- branchFromNet()

Routing:
- orthoStep()
- orthoPolyline()
- portSideH()
- junctionExitH()
- portExitH()
- wireOpts()
- wireRoute()
- wirePath()
- routeParts()
- hoppedPathD()
- nearestOnWire()

Net operations:
- netWiresFrom()
- netDriverPort()
- normalizePortFanout()
- tappedBitsOnNet()

Layout healing:
- bodyClearance()
- tapClearOfBodies()
- nearestClearOnWire()
- alignJunctionBranch()
- firstSegFromJunction()
- reflowJunctions()
- separateWireOverlaps()
- retapBranches()
- healLayout()
*/
