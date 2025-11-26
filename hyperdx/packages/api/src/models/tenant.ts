import mongoose, { Schema } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

type ObjectId = mongoose.Types.ObjectId;

export interface ITenant {
  _id: ObjectId;
  id: string;
  name: string;
  slug?: string;
  apiKey: string;
  isActive: boolean;
  settings?: {
    [key: string]: any;
  };
}

export type TenantDocument = mongoose.HydratedDocument<ITenant>;

const TenantSchema = new Schema<ITenant>(
  {
    name: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      required: false,
      unique: true,
      sparse: true, // allows multiple null values while enforcing uniqueness for non-null values
    },
    apiKey: {
      type: String,
      default: function genUUID() {
        return uuidv4();
      },
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    settings: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes
TenantSchema.index({ name: 1 });
TenantSchema.index({ apiKey: 1 }, { unique: true });

export default mongoose.model<ITenant>('Tenant', TenantSchema);

