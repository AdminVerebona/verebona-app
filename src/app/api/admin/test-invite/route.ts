import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/services/account-service';

export async function POST(req: NextRequest) {
  try {
    const { accountId, email, invitedBy } = await req.json();
    
    const result = await AccountService.inviteMember(accountId, email, invitedBy);
    
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error('Test invite error:', error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
