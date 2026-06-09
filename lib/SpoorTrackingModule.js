import { AbstractModule } from 'adapt-authoring-core'
import { parseObjectId } from 'adapt-authoring-mongodb'
import { loadRouteConfig, registerRoutes } from 'adapt-authoring-server'
/**
 * Module for making course content compatible with spoor
 * @memberof spoortracking
 * @extends {AbstractModule}
 */
class SpoorTrackingModule extends AbstractModule {
  /** @override */
  async init () {
    const [auth, content, mongodb, server] = await this.app.waitForModule('auth', 'content', 'mongodb', 'server')

    /** @ignore */ this.content = content
    /** @ignore */ this.mongodb = mongodb

    // Mint a tracking ID for every new block. preInsertHook also fires once per payload during a
    // bulk clone, so this is the single place tracking IDs are assigned.
    content.preInsertHook.tap(this.insertTrackingId.bind(this))

    const config = await loadRouteConfig(this.rootDir, this)
    const router = server.api.createChildRouter(config.root)
    registerRoutes(router, config.routes, auth)
  }

  /**
   * Collection holding the per-course tracking ID counters. Shared with the content module's
   * friendly ID counters, so deleting a course removes both in content's existing sweep.
   * @type {String}
   */
  get counterCollectionName () {
    return this.content.counterCollectionName
  }

  /**
   * Assigns a unique tracking ID to a newly inserted block. Language replicas created by the
   * multilang module deliberately reuse the source block's ID, so those (flagged `_multilangSync`)
   * inserts are left untouched.
   * @param {Object} data The content being inserted
   * @param {Object} options Insert options
   * @return {Promise}
   */
  async insertTrackingId (data, options = {}) {
    if (data._type !== 'block' || options._multilangSync) {
      return
    }
    const [trackingId] = await this.allocateTrackingIds(data._courseId, 1)
    data._trackingId = trackingId
  }

  /**
   * Atomically reserves a contiguous range of unique tracking IDs for a course's blocks. The
   * counter is advanced with a single findOneAndUpdate, so allocation never reads back through
   * the cached content query that previously handed colliding IDs to rapid/concurrent inserts.
   * @param {String} _courseId The course the blocks belong to
   * @param {Number} count Number of IDs to reserve
   * @return {Promise<Array<Number>>}
   */
  async allocateTrackingIds (_courseId, count = 1) {
    if (count < 1) {
      return []
    }
    const counters = this.mongodb.getCollection(this.counterCollectionName)
    const query = { _type: '_trackingId', _courseId: parseObjectId(_courseId) }
    // Seed from any existing blocks on first use (e.g. courses that predate this counter)
    if (!await counters.findOne(query)) {
      const maxTrackingId = await this.findMaxTrackingId(_courseId)
      await counters.updateOne(query, { $setOnInsert: { seq: maxTrackingId } }, { upsert: true })
    }
    const counter = await counters.findOneAndUpdate(query, { $inc: { seq: count } }, { returnDocument: 'after' })
    const startSeq = counter.seq - count + 1
    return Array.from({ length: count }, (_, i) => startSeq + i)
  }

  /**
   * Finds the highest tracking ID currently assigned to a course's blocks (used to seed the
   * counter). Reads the DB directly to bypass the content cache.
   * @param {String} _courseId The course _id
   * @return {Promise<Number>}
   */
  async findMaxTrackingId (_courseId) {
    const [block] = await this.mongodb.getCollection(this.content.collectionName)
      .find({ _type: 'block', _courseId: parseObjectId(_courseId), _trackingId: { $type: 'number' } }, { projection: { _trackingId: 1 } })
      .sort({ _trackingId: -1 })
      .limit(1)
      .toArray()
    return block?._trackingId ?? 0
  }

  /**
   * Resets all tracking IDs for a single course to a clean 1..n sequence and realigns the counter.
   * This is the canonical way to renumber a course's tracking IDs — reuse it rather than
   * reimplementing the renumbering elsewhere.
   * @param {String} _courseId The course _id
   * @return {Promise}
   */
  async resetCourseTrackingIds (_courseId) {
    const collection = this.mongodb.getCollection(this.content.collectionName)
    const blocks = await collection
      .find({ _type: 'block', _courseId: parseObjectId(_courseId) }, { projection: { _id: 1 } })
      .sort({ _trackingId: 1 })
      .toArray()
    await Promise.all(blocks.map((b, i) => collection.updateOne({ _id: b._id }, { $set: { _trackingId: i + 1 } })))
    // Keep the allocation counter in step with the renumbering
    await this.mongodb.getCollection(this.counterCollectionName)
      .updateOne({ _type: '_trackingId', _courseId: parseObjectId(_courseId) }, { $set: { seq: blocks.length } }, { upsert: true })
    this.log('debug', 'RESET', _courseId)
  }

  /**
   * Express handler for reseting all tracking IDs for a single course
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
   * @param {Function} next
   */
  async resetTrackingHandler (req, res, next) {
    try {
      await this.resetCourseTrackingIds(req.params._courseId)
      res.sendStatus(204)
    } catch (e) {
      return next(e)
    }
  }
}

export default SpoorTrackingModule
