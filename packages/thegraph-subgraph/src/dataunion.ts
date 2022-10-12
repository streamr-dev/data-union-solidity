import { log, Address, BigInt } from '@graphprotocol/graph-ts'

import { DataUnion, DataUnionStatsBucket, Member, RevenueEvent } from '../generated/schema'
import { MemberJoined, MemberParted, RevenueReceived } from '../generated/templates/DataUnion/DataUnionTemplate'

export function handleMemberJoined(event: MemberJoined): void {
    let duAddress = event.address
    let memberAddress = event.params.member
    log.warning('handleMemberJoined: member={} duAddress={}', [memberAddress.toHexString(), duAddress.toHexString()])

    let memberId = getMemberId(memberAddress, duAddress)
    let member = new Member(memberId)
    member.address = memberAddress.toHexString()
    member.dataUnion = duAddress.toHexString()
    member.joinDate = event.block.timestamp
    member.status = 'ACTIVE'
    member.save()

    updateDataUnion(duAddress, event.block.timestamp, 1, BigInt.zero())
}

export function handleMemberParted(event: MemberParted): void {
    let duAddress = event.address
    let memberAddress = event.params.member
    log.warning('handleMemberParted: member={} duAddress={}', [memberAddress.toHexString(), duAddress.toHexString()])

    let memberId = getMemberId(memberAddress, duAddress)
    let member = Member.load(memberId)
    member!.status = 'INACTIVE'
    member!.save()

    updateDataUnion(duAddress, event.block.timestamp, -1, BigInt.zero())
}

export function handleRevenueReceived(event: RevenueReceived): void {
    let duAddress = event.address
    let amount = event.params.amount
    log.warning('handleRevenueReceived: duAddress={} amount={}', [duAddress.toHexString(), amount.toString()])

    updateDataUnion(duAddress, event.block.timestamp, 0, amount)

    // additionally save the individual events for later querying
    let revenueEvent = new RevenueEvent(
        duAddress.toHexString() + '-' +
        event.block.number.toString() + '-' +
        event.transaction.index.toHexString() + '-' +
        event.transactionLogIndex.toString()
    )
    revenueEvent.dataUnion = duAddress.toHexString()
    revenueEvent.amountWei = amount
    revenueEvent.date = event.block.timestamp
    revenueEvent.save()
}

function getMemberId(memberAddress: Address, duAddress: Address): string {
    return memberAddress.toHexString() + '-' + duAddress.toHexString()
}

function getDataUnion(duAddress: Address): DataUnion | null {
    let dataUnion = DataUnion.load(duAddress.toHexString())
    if (dataUnion != null) {
        return dataUnion
    } else {
        log.error('getDataUnion: DU was not found, address={}', [duAddress.toHexString()])
    }
    return null
}

function updateDataUnion(duAddress: Address, timestamp: BigInt, memberCountChange: i32, revenueChangeWei: BigInt): void {
    log.warning('updateDataUnion: duAddress={} timestamp={}', [duAddress.toHexString(), timestamp.toString()])

    let dataUnion = getDataUnion(duAddress)
    if (dataUnion != null) {
        dataUnion.memberCount += memberCountChange
        dataUnion.revenueWei += revenueChangeWei
        dataUnion.save()
    } else {
        log.error('updateDataUnion: DU was not found, address={}', [duAddress.toHexString()])
    }

    let hourBucket = getBucket('HOUR', timestamp, duAddress)
    hourBucket!.memberCountChange += memberCountChange
    hourBucket!.revenueChangeWei += revenueChangeWei
    hourBucket!.save()

    let dayBucket = getBucket('DAY', timestamp, duAddress)
    dayBucket!.memberCountChange += memberCountChange
    dayBucket!.revenueChangeWei += revenueChangeWei
    dayBucket!.save()
}

function getBucket(length: string, timestamp: BigInt, duAddress: Address): DataUnionStatsBucket | null {
    let nearestBucket = getNearestBucket(length, timestamp)
    let bucketId = length + '-' + nearestBucket.toString()

    log.warning('getBucket: nearestBucket={}', [nearestBucket.toString()])

    let existingBucket = DataUnionStatsBucket.load(bucketId)
    if (existingBucket == null) {
        // Get DataUnion to fetch member count at the start of the bucket timespan
        let memberCount = 0
        let revenueWei = BigInt.zero()
        let dataUnion = getDataUnion(duAddress)
        if (dataUnion != null) {
            memberCount = dataUnion.memberCount
            revenueWei = dataUnion.revenueWei
        }

        // Create new bucket
        let newBucket = new DataUnionStatsBucket(bucketId)
        newBucket.type = length
        newBucket.dataUnion = duAddress.toHexString()
        newBucket.startDate = nearestBucket
        newBucket.endDate = nearestBucket.plus(getBucketLength(length))
        newBucket.memberCountAtStart = memberCount
        newBucket.revenueAtStartWei = revenueWei
        newBucket.memberCountChange = 0
        newBucket.revenueChangeWei = BigInt.zero()
        newBucket.save()
        return newBucket
    }

    return existingBucket
}

function getNearestBucket(length: string, timestamp: BigInt): BigInt {
    let seconds = getBucketLength(length)
    let prev = timestamp.minus(timestamp.mod(seconds))
    return prev
}

function getBucketLength(length: string): BigInt {
    if (length === 'HOUR') {
        return BigInt.fromI32(60 * 60)
    }
    else if (length === 'DAY') {
        return BigInt.fromI32(24 * 60 * 60)
    }
    else {
        log.error('getBucketLength: unknown length={}', [length])
    }
    return BigInt.fromI32(0)
}
